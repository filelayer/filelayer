---
title: "404, Not 403: What Happens When Someone Loses Access to a File?"
date: 2026-11-25
authorNote: "Jorge Urios maintains Filelayer, an open-source Node library for user files in SaaS apps (per-file permissions, revocable links, audit log)."
---

Returning 404 Not Found instead of 403 Forbidden is not a new security idea.

[GitHub documents this behavior](https://docs.github.com/rest/using-the-rest-api/troubleshooting-the-rest-api). Its REST API uses 404 instead of 403 to avoid confirming that private repositories exist. [MDN describes the same option](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/403) in its documentation for HTTP 403 responses.

The principle is straightforward: sometimes, telling someone that a resource exists is information they should not have.

But implementing this principle in a file-sharing system involves more than changing an HTTP status code.

A file can reveal its existence through several other parts of the application, even when its download endpoint returns 404.

Let’s look at what that means in practice.

## The problem with confirming that a file exists

Imagine a SaaS application where users can upload private documents.

Alice belongs to Organization A. Bob belongs to Organization B.

Alice uploads a confidential document. Bob somehow obtains its file ID.

Bob makes a request:

```http
GET /api/files/file_8f32a1
```

The server responds:

```http
HTTP/1.1 403 Forbidden
```

The server has denied access, but it has also confirmed something:

`file_8f32a1` exists.

This creates an enumeration opportunity. Someone can test file identifiers, share links or organization resources and distinguish existing resources from nonexistent ones.

In a multi-tenant application, this is particularly problematic. The existence of another organization’s file is itself information that should remain private.

Returning 404 Not Found is one way to avoid disclosing that information.

```http
HTTP/1.1 404 Not Found
```

The important part is consistency.

## A 404 response is only the beginning

A common implementation mistake is to change the status code while leaving other parts of the application untouched.

Consider four additional places where a file-sharing system can disclose the same information.

### 1. The error response body

Changing 403 to 404 does not help much if the response body explains why access was denied.

For example:

```json
{
  "error": {
    "code": "FILE_NOT_FOUND",
    "reason": "no_membership"
  }
}
```

The status code says the file was not found.

The response body says the caller lacks membership.

That distinction defeats the purpose.

Internal reasons such as:

- `no_membership`
- `grant_revoked`
- `bad_link_secret`

should remain server-side.

The public response should use a stable error code that does not disclose the internal authorization decision.

The application can retain the actual reason in its internal audit records.

### 2. File listings

Individual file endpoints are not the only place where resources can be enumerated.

Imagine two requests:

- A user lists files belonging to an organization they cannot access.
- A user lists files belonging to an organization that does not exist.

If the responses are different, the listing endpoint becomes another way to discover organizations.

A system should return the same empty result in both cases.

For example:

```json
{
  "data": [],
  "has_more": false
}
```

The goal is to avoid turning listing behavior into an existence oracle.

### 3. Unknown users and audit logs

This is an easy detail to overlook.

Suppose someone who has never been registered in the application tries to access a private file.

The system must deny the request. It must not silently fall back to anonymous access.

But there is another question:

Where should the attempt be recorded?

If the application first resolves the target organization and then writes the attempt into that organization’s audit log, the logging system has already revealed information about the resource owner.

For an unknown user, the attempt should be recorded in a project-level system audit chain rather than the target organization’s audit log.

This preserves operational visibility without disclosing which organization owns the resource.

### 4. Role-based permissions

Consider an organization member who attempts an administrative operation.

The member does not have the required permissions.

The operation itself is not secret. Administrative operations are part of the application’s public interface.

The information that needs protection is the target of the operation.

Returning 403 to an ordinary member, and 404 to a stranger, can let the caller learn things about the target that they have no right to know.

For example, they might discover whether a particular user belongs to an organization or what role that user holds.

The API should return the same externally visible denial to both callers.

There is an important consequence for frontend developers:

Do not rely on the HTTP status code alone to explain why someone cannot perform an operation.

If your interface needs to tell an administrator that a member lacks a particular permission, it should derive that information from the authenticated session and permissions already available to the application.

The API response should not become a source of information for unauthorized callers.

We encountered this distinction ourselves. An integration review found that one of our documentation statements promised a 403 response that the API did not actually return. The discrepancy was identified against version 0.8.0 in October 2026.

It was a useful reminder that security documentation must describe actual API behavior, not intended behavior.

## When 403 is still appropriate

This does not mean every authorization failure should return 404.

There are situations where the caller already has legitimate access to the relevant resource and the application can safely explain that an operation is forbidden.

For example:

- An administrator attempts to promote someone above their own role.
- An owner attempts to remove the last remaining owner.
- A user attempts to widen a delegated permission grant beyond their authority.

In these cases, the caller already has standing to see the relevant resource.

A 403 can communicate that the requested operation violates the application’s rules without revealing the existence of something the caller should not know about.

The distinction is contextual.

## What happens when access is revoked during a download?

The most interesting case is not necessarily an ordinary denied request.

It is what happens when access changes while a user is interacting with a file.

Consider this sequence:

1. Bob has permission to download a private file.
2. Bob requests the first five bytes.
3. The server returns 206 Partial Content.
4. Alice revokes Bob’s access.
5. Bob requests the next byte range.

The second request must evaluate the current authorization state.

If Bob no longer has access, the response should be:

```http
HTTP/1.1 404 Not Found
```

The fact that Bob previously had permission should not automatically grant him continued access.

This is particularly important for systems that support range requests, resumable downloads and revocable sharing links.

A previously authorized request is not a permanent authorization grant.

## What this approach does not solve

There are limitations worth acknowledging.

### Timing differences

Returning the same status code does not guarantee that the server behaves identically in every observable way.

A request for a nonexistent file might take a different amount of time from a request for an existing file that the caller cannot access.

An attacker may potentially use repeated timing measurements to infer information.

This is a known limitation of the general approach.

We have not measured timing differences in our implementation, so we should not claim that this channel has been eliminated.

### Debugging becomes harder

There is also an operational cost.

A developer receives 404, but the resource might actually exist.

The real reason could be:

- The file never existed.
- Access was revoked.
- A share link expired.
- A download limit was reached.
- The caller does not belong to the organization.
- The caller lacks the required role.

GitHub itself documents troubleshooting scenarios where an API returns 404 for a resource that exists.

This is why internal diagnostics matter.

The server should retain the actual denial reason in its internal logs or audit infrastructure, where authorized operators can investigate it.

The public response and the internal diagnostic record serve different purposes.

## Thinking about file security as a complete system

The broader lesson is that authorization cannot be implemented as a single check on a download endpoint.

In a multi-tenant file-sharing application, the same confidentiality rule must apply consistently to:

- File retrieval.
- Share links.
- File listings.
- Error responses.
- Organization boundaries.
- Role-based operations.
- Revocation.
- Audit routing.

A system that protects its download endpoint but leaks resource existence through listings or error messages has not implemented the principle consistently.

The objective is to ensure that callers cannot use different parts of the application to discover resources they are not authorized to access.

This is one of the problems we think about when building file infrastructure for SaaS applications.

I maintain Filelayer, an open-source Node library for user files in SaaS apps (per-file permissions, revocable links, audit log).

If you are building a multi-tenant application, how do you handle resource-existence disclosure across your APIs?

I’d be interested in hearing how other teams approach this.
