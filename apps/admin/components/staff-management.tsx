"use client";
import { useState } from "react";
import {
  staffListResponseSchema,
  staffResponseSchema,
  staffEditRequestSchema,
  staffRoleRequestSchema,
  staffDeactivateRequestSchema,
  staffReactivateRequestSchema,
  invitationRequestSchema,
  invitationResponseSchema,
} from "@ih/contracts";
import { emptyResponse, managementRequest, validate } from "../lib/management";
import { Fields, ResourceNotice, useManagementResource } from "./management-resource";
import { useSession } from "./session-shell";
export function StaffManagement() {
  const session = useSession();
  const [cursor, setCursor] = useState<string | null>(null);
  const resource = useManagementResource(
    "/staff?limit=25" + (cursor ? "&after=" + encodeURIComponent(cursor) : ""),
    staffListResponseSchema,
  );
  const [invitation, setInvitation] = useState<{ id: string; expiresAt: string } | null>(null);
  async function invite(data: FormData, form: HTMLFormElement) {
    const outcome = await resource.run((signal) =>
      managementRequest(
        "/staff/invitations",
        invitationResponseSchema,
        "POST",
        validate(invitationRequestSchema, {
          name: String(data.get("name") ?? "").trim(),
          email: String(data.get("email") ?? "").trim(),
          role: data.get("role"),
        }),
        signal,
      ),
    );
    if (outcome.ok) {
      setInvitation(outcome.value);
      form.reset();
    }
  }
  return (
    <>
      <ResourceNotice resource={resource} />
      {resource.data && (
        <>
          <section className="management-card">
            <h2>Invite a team member</h2>
            <p className="muted">
              Owner has full access; Staff has operational permissions. Issuing another invitation
              for the same email replaces the pending link. Email delivery depends on configured
              provisioning.
            </p>
            <form
              data-unsaved="this invitation"
              onSubmit={(e) => {
                e.preventDefault();
                void invite(new FormData(e.currentTarget), e.currentTarget);
              }}
            >
              <fieldset disabled={resource.disabled}>
                <Fields
                  fields={[
                    { name: "name", label: "Full name", required: true, max: 100 },
                    { name: "email", label: "Email", kind: "email", required: true, max: 254 },
                  ]}
                  value={null}
                />
                <label>
                  Role
                  <select name="role" defaultValue="staff">
                    <option value="staff">Staff — operations</option>
                    <option value="owner">Owner — full access</option>
                  </select>
                </label>
                <button className="primary-button" type="submit">
                  Queue invitation
                </button>
              </fieldset>
            </form>
            {invitation && (
              <div className="notice" role="status">
                <p>
                  Invitation queued. Link expires {new Date(invitation.expiresAt).toLocaleString()}.
                  Delivery has not been confirmed.
                </p>
                <button
                  className="secondary-button"
                  disabled={resource.disabled}
                  onClick={async () => {
                    if (!window.confirm("Revoke this invitation?")) return;
                    const outcome = await resource.run((signal) =>
                      managementRequest(
                        "/staff/invitations/revoke",
                        emptyResponse,
                        "POST",
                        { invitationId: invitation.id },
                        signal,
                      ),
                    );
                    if (outcome.ok) setInvitation(null);
                  }}
                >
                  Revoke this invitation
                </button>
              </div>
            )}
          </section>
          <section className="management-card">
            <h2>Staff & roles</h2>
            <p className="muted">
              Account, email and role changes may revoke sessions. At least one active Owner must
              remain. Role and activation are separate commands.
            </p>
            {resource.data.items.length === 0 && <p className="muted">No staff on this page.</p>}
            <div className="record-list">
              {resource.data.items.map((staff) => {
                const self = staff.id === session?.user.id;
                async function replace(command: string, body: unknown) {
                  const outcome = await resource.run((signal) =>
                    managementRequest(
                      `/staff/${staff.id}${command}`,
                      staffResponseSchema,
                      command ? "POST" : "PATCH",
                      body,
                      signal,
                    ),
                  );
                  if (outcome.ok) {
                    if (
                      self &&
                      (outcome.value.email !== session?.user.email ||
                        outcome.value.role !== session?.user.role)
                    )
                      window.location.replace("/login?reason=expired");
                    else
                      resource.setData((current) =>
                        current
                          ? {
                              ...current,
                              items: current.items.map((item) =>
                                item.id === staff.id ? outcome.value : item,
                              ),
                            }
                          : current,
                      );
                  }
                }
                return (
                  <article className="record-card" key={`${staff.id}-${staff.version}`}>
                    <header className="card-heading">
                      <h3>
                        {staff.name}
                        {self ? " (you)" : ""}
                      </h3>
                      <span className="badge">
                        {staff.role === "owner" ? "Owner" : "Staff"} ·{" "}
                        {staff.active ? "Active" : "Deactivated"} · v{staff.version}
                      </span>
                    </header>
                    <p className="muted">
                      Last active:{" "}
                      {staff.lastActiveAt
                        ? new Date(staff.lastActiveAt).toLocaleString()
                        : "No activity recorded"}
                    </p>
                    <form
                      data-unsaved={staff.name}
                      onSubmit={(e) => {
                        e.preventDefault();
                        const data = new FormData(e.currentTarget);
                        void resource
                          .run(async (signal) => {
                            const body = validate(staffEditRequestSchema, {
                              version: staff.version,
                              name: String(data.get("name") ?? "").trim(),
                              email: String(data.get("email") ?? "").trim(),
                            });
                            const row = await managementRequest(
                              `/staff/${staff.id}`,
                              staffResponseSchema,
                              "PATCH",
                              body,
                              signal,
                            );
                            return row;
                          })
                          .then((outcome) => {
                            if (outcome.ok) {
                              if (self && outcome.value.email !== session?.user.email)
                                window.location.replace("/login?reason=expired");
                              else
                                resource.setData((current) =>
                                  current
                                    ? {
                                        ...current,
                                        items: current.items.map((item) =>
                                          item.id === staff.id ? outcome.value : item,
                                        ),
                                      }
                                    : current,
                                );
                            }
                          });
                      }}
                    >
                      <fieldset disabled={resource.disabled}>
                        <Fields
                          fields={[
                            { name: "name", label: "Full name", required: true, max: 100 },
                            {
                              name: "email",
                              label: "Email",
                              kind: "email",
                              required: true,
                              max: 254,
                            },
                          ]}
                          value={staff}
                        />
                        <button className="secondary-button" type="submit">
                          Save profile
                        </button>
                      </fieldset>
                    </form>
                    <form
                      data-unsaved={staff.name}
                      onSubmit={(e) => {
                        e.preventDefault();
                        const data = new FormData(e.currentTarget);
                        if (
                          !window.confirm(
                            `Change ${staff.name}'s role? Their sessions will be revoked.${self ? " You may be signed out." : ""}`,
                          )
                        )
                          return;
                        void resource
                          .run(async (signal) =>
                            managementRequest(
                              `/staff/${staff.id}/role`,
                              staffResponseSchema,
                              "POST",
                              validate(staffRoleRequestSchema, {
                                version: staff.version,
                                role: data.get("role"),
                              }),
                              signal,
                            ),
                          )
                          .then((outcome) => {
                            if (outcome.ok) {
                              if (self && outcome.value.role !== session?.user.role)
                                window.location.replace("/login?reason=expired");
                              else
                                resource.setData((current) =>
                                  current
                                    ? {
                                        ...current,
                                        items: current.items.map((item) =>
                                          item.id === staff.id ? outcome.value : item,
                                        ),
                                      }
                                    : current,
                                );
                            }
                          });
                      }}
                    >
                      <fieldset disabled={resource.disabled}>
                        <label>
                          Role
                          <select name="role" defaultValue={staff.role}>
                            <option value="staff">Staff</option>
                            <option value="owner">Owner</option>
                          </select>
                        </label>
                        <button className="secondary-button" type="submit">
                          Change role
                        </button>
                      </fieldset>
                    </form>
                    <button
                      className="secondary-button"
                      disabled={resource.disabled}
                      onClick={async () => {
                        if (
                          !window.confirm(
                            `${staff.active ? "Deactivate" : "Reactivate"} ${staff.name}?${staff.active ? " Existing sessions will be revoked." : " Old sessions remain revoked."}${self ? " You will be signed out." : ""}`,
                          )
                        )
                          return;
                        if (staff.active) {
                          const outcome = await resource.run((signal) =>
                            managementRequest(
                              `/staff/${staff.id}/deactivate`,
                              emptyResponse,
                              "POST",
                              validate(staffDeactivateRequestSchema, { version: staff.version }),
                              signal,
                            ),
                          );
                          if (outcome.ok) {
                            if (self) window.location.replace("/login?reason=expired");
                            else resource.reload();
                          }
                        } else
                          await replace(
                            "/reactivate",
                            validate(staffReactivateRequestSchema, { version: staff.version }),
                          );
                      }}
                    >
                      {staff.active ? "Deactivate account" : "Reactivate account"}
                    </button>
                  </article>
                );
              })}
            </div>
            <div className="form-actions">
              <button
                className="secondary-button"
                disabled={!cursor || resource.busy}
                onClick={() => setCursor(null)}
              >
                First page
              </button>
              <button
                className="secondary-button"
                disabled={!resource.data.nextCursor || resource.busy}
                onClick={() => setCursor(resource.data!.nextCursor)}
              >
                Next page
              </button>
            </div>
          </section>
        </>
      )}
    </>
  );
}
