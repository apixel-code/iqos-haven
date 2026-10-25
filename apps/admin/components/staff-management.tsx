"use client";
import { confirmDialog } from "../lib/ui/confirm";
import { toast } from "../lib/ui/toast";
import { useId, useRef, useState } from "react";
import {
  staffListResponseSchema,
  staffResponseSchema,
  staffEditRequestSchema,
  staffRoleRequestSchema,
  staffDeactivateRequestSchema,
  staffReactivateRequestSchema,
  invitationRequestSchema,
  invitationResponseSchema,
  pendingInvitationsResponseSchema,
} from "@ih/contracts";
import { emptyResponse, managementRequest, validate } from "../lib/management";
import { when } from "../lib/orders";
import { ACCESS_AREAS, initials, roleCan } from "../lib/staff";
import { Icon } from "./icons";
import { Fields, ResourceNotice, useManagementResource } from "./management-resource";
import { Drawer } from "./overlays";
import { PageHead } from "./page-head";
import { Pop } from "./pop";
import { useSession } from "./session-shell";

type Staff = ReturnType<typeof staffResponseSchema.parse>;
type Role = Staff["role"];

/**
 * Staff & roles (architecture §11, parity G-A11) in the prototype's layout (`VIEWS.staff`, ADR
 * 0097 V-A15): the team table with a row menu, an Add staff drawer that queues an invitation,
 * the pending invitations, the two roles and an access summary read from the real grants.
 * Role, profile and activation stay separate commands; at least one active Owner remains.
 */
export function StaffManagement() {
  const session = useSession();
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const resource = useManagementResource(
    "/staff?limit=25" + (cursor ? "&after=" + encodeURIComponent(cursor) : ""),
    staffListResponseSchema,
  );
  const pending = useManagementResource("/staff/invitations", pendingInvitationsResponseSchema);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [invitation, setInvitation] = useState<{ id: string; expiresAt: string } | null>(null);
  const [resetSent, setResetSent] = useState<string | null>(null);

  const put = (next: Staff) =>
    resource.setData((current) =>
      current
        ? { ...current, items: current.items.map((item) => (item.id === next.id ? next : item)) }
        : current,
    );
  /** A change to one's own email, role or access ends the session: sign in again. */
  const afterChange = (staff: Staff, next: Staff) => {
    const self = staff.id === session?.user.id;
    if (self && (next.email !== session?.user.email || next.role !== session?.user.role))
      window.location.replace("/login?reason=expired");
    else put(next);
  };
  async function toggle(staff: Staff) {
    const self = staff.id === session?.user.id;
    if (
      !(await confirmDialog({
        title: `${staff.active ? "Deactivate" : "Reactivate"} ${staff.name}?`,
        body: `${staff.active ? "They are signed out right away and can't sign in until reactivated. Their past actions stay in order timelines." : "Old sessions stay ended; they sign in again."}${self ? " You will be signed out." : ""}`,
        ok: staff.active ? "Deactivate" : "Reactivate",
        danger: staff.active,
      }))
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
        else {
          resource.reload();
          toast(`${staff.name} deactivated`);
        }
      }
    } else {
      const outcome = await resource.run((signal) =>
        managementRequest(
          `/staff/${staff.id}/reactivate`,
          staffResponseSchema,
          "POST",
          validate(staffReactivateRequestSchema, { version: staff.version }),
          signal,
        ),
      );
      if (outcome.ok) {
        afterChange(staff, outcome.value);
        toast(`${staff.name} reactivated`);
      }
    }
  }
  async function reset(staff: Staff) {
    if (
      !(await confirmDialog({
        title: `Email ${staff.name} a password reset link?`,
        body: "Their current password keeps working until they use it.",
        ok: "Send reset link",
      }))
    )
      return;
    setResetSent(null);
    const outcome = await resource.run((signal) =>
      managementRequest(
        `/staff/${staff.id}/password-reset`,
        emptyResponse,
        "POST",
        undefined,
        signal,
      ),
    );
    if (outcome.ok) setResetSent(staff.email);
  }
  async function revoke(item: { id: string; email: string }) {
    if (
      !(await confirmDialog({
        title: `Revoke the invitation for ${item.email}?`,
        body: "The invitation link stops working.",
        ok: "Revoke invitation",
        danger: true,
      }))
    )
      return;
    const outcome = await pending.run((signal) =>
      managementRequest(
        "/staff/invitations/revoke",
        emptyResponse,
        "POST",
        { invitationId: item.id },
        signal,
      ),
    );
    if (outcome.ok) {
      if (invitation?.id === item.id) setInvitation(null);
      pending.reload();
      toast("Invitation revoked");
    }
  }

  const items = resource.data?.items ?? [];
  return (
    <>
      <PageHead
        title="Staff & Roles"
        sub="Who can sign in to the admin and what they can do."
        actions={
          <button type="button" className="btn btn-p" onClick={() => setInviting(true)}>
            <Icon name="plus" />
            Add staff
          </button>
        }
      />
      <ResourceNotice resource={resource} compact />
      {invitation && (
        <div className="note ok" role="status">
          <Icon name="send" />
          <p>
            Invitation queued. Link expires {when(invitation.expiresAt)}. Delivery has not been
            confirmed.
          </p>
        </div>
      )}
      {resetSent && (
        <div className="note ok" role="status">
          <Icon name="mail" />
          <p>
            Password reset link queued for {resetSent}. It works for 30 minutes. Delivery has not
            been confirmed.
          </p>
        </div>
      )}
      {resource.data && (
        <section className="tbl-wrap" aria-label="Team">
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="hide-m">Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th className="hide-m">Last active</th>
                  <th className="w1">
                    <span className="sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((staff) => {
                  const self = staff.id === session?.user.id;
                  return (
                    <tr key={`${staff.id}-${staff.version}`} className="staff-row">
                      <td>
                        <div className="cellp">
                          <span className="av" aria-hidden="true">
                            {initials(staff.name)}
                          </span>
                          <div>
                            <b>
                              {staff.name}
                              {self && <span className="muted small"> (you)</span>}
                            </b>
                            <small className="only-m">{staff.email}</small>
                          </div>
                        </div>
                      </td>
                      <td className="small hide-m">{staff.email}</td>
                      <td>
                        <RoleTag role={staff.role} />
                      </td>
                      <td>
                        {staff.active ? (
                          <span className="tag ok">Active</span>
                        ) : (
                          <span className="tag">Deactivated</span>
                        )}
                      </td>
                      <td className="small muted hide-m">
                        {staff.lastActiveAt ? when(staff.lastActiveAt) : "No activity recorded"}
                      </td>
                      <td className="w1">
                        <RowMenu
                          staff={staff}
                          disabled={resource.disabled}
                          onEdit={() => setEditing(staff)}
                          onReset={() => void reset(staff)}
                          onToggle={() => void toggle(staff)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(cursors.length > 0 || resource.data.nextCursor) && (
            <div className="tbl-f">
              <span>{items.length} on this page</span>
              <div className="pager">
                <button
                  type="button"
                  aria-label="Previous page"
                  disabled={cursors.length === 0 || resource.busy}
                  onClick={() => setCursors((value) => value.slice(0, -1))}
                >
                  <Icon name="cl" size="sm" />
                </button>
                <button type="button" aria-current="page" aria-label={`Page ${cursors.length + 1}`}>
                  {cursors.length + 1}
                </button>
                <button
                  type="button"
                  aria-label="Next page"
                  disabled={!resource.data.nextCursor || resource.busy}
                  onClick={() => setCursors((value) => [...value, resource.data!.nextCursor!])}
                >
                  <Icon name="cr" size="sm" />
                </button>
              </div>
            </div>
          )}
        </section>
      )}
      <section className="card" aria-labelledby="staff-pending">
        <div className="card-h">
          <div>
            <h2 id="staff-pending">Pending invitations</h2>
            <p className="sub">
              Not yet accepted. A link works for 24 hours; revoke one sent to the wrong person, or
              invite the same email again for a new link.
            </p>
          </div>
        </div>
        <div className="card-b staff-pending-b">
          <ResourceNotice resource={pending} compact />
        </div>
        {pending.data &&
          (pending.data.items.length === 0 ? (
            <div className="card-b">
              <p className="small muted">No pending invitations.</p>
            </div>
          ) : (
            <div className="list">
              {pending.data.items.map((item) => (
                <div className="li inv-row" key={item.id}>
                  <span className="av" aria-hidden="true">
                    {initials(item.name)}
                  </span>
                  <span className="li-b">
                    <b>{item.name}</b>
                    <small>
                      {item.email} · {item.role === "owner" ? "Owner" : "Staff"} ·{" "}
                      {item.expired ? "Expired" : "Pending"} · invited {when(item.createdAt)}
                      {item.invitedBy ? ` by ${item.invitedBy}` : ""} ·{" "}
                      {item.expired ? "expired" : "expires"} {when(item.expiresAt)}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="btn btn-s btn-sm"
                    disabled={pending.disabled}
                    onClick={() => void revoke(item)}
                  >
                    Revoke invitation
                  </button>
                </div>
              ))}
            </div>
          ))}
      </section>
      <div className="grid g2">
        <section className="card" aria-labelledby="role-owner">
          <div className="card-h">
            <h2 id="role-owner" className="role-h">
              <Icon name="shield" /> Owner
            </h2>
            <span className="tag pub">Full access</span>
          </div>
          <div className="card-b prose">
            <p>
              Everything in the admin, including revenue, analytics, reports, exports, storefront
              content, settings and staff accounts. At least one active Owner always remains.
            </p>
          </div>
        </section>
        <section className="card" aria-labelledby="role-staff">
          <div className="card-h">
            <h2 id="role-staff" className="role-h">
              <Icon name="user" /> Staff
            </h2>
            <span className="tag">Operations</span>
          </div>
          <div className="card-b prose">
            <p>
              Day-to-day commerce: orders, products, categories, brands, inventory, and customer
              lookup for order support. Revenue, exports and settings are hidden.
            </p>
          </div>
        </section>
      </div>
      <section className="tbl-wrap" aria-labelledby="staff-access">
        <div className="card-h an-tbl-h">
          <h2 id="staff-access">Access summary</h2>
          <span className="tag">Custom roles · not at launch</span>
        </div>
        <div className="tbl-scroll">
          <table className="perm">
            <thead>
              <tr>
                <th>Area</th>
                <th className="c">Owner</th>
                <th className="c">Staff</th>
              </tr>
            </thead>
            <tbody>
              {ACCESS_AREAS.map(([label, permission]) => (
                <tr key={label}>
                  <td>{label}</td>
                  {(["owner", "staff"] as const).map((role) => (
                    <td className="c" key={role}>
                      {roleCan(role, permission) ? (
                        <span className="yes">
                          <Icon name="check" />
                          <span className="sr">Allowed</span>
                        </span>
                      ) : (
                        <span className="no">
                          <Icon name="minus" />
                          <span className="sr">Not allowed</span>
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {inviting && (
        <InviteDrawer
          resource={resource}
          onClose={() => setInviting(false)}
          onQueued={(queued) => {
            setInviting(false);
            setInvitation(queued);
            pending.reload();
            toast("Invitation queued");
          }}
        />
      )}
      {editing && (
        <EditDrawer
          key={`${editing.id}-${editing.version}`}
          staff={editing}
          self={editing.id === session?.user.id}
          resource={resource}
          onClose={() => setEditing(null)}
          onSaved={(next, what) => {
            setEditing(null);
            afterChange(editing, next);
            toast(what);
          }}
        />
      )}
    </>
  );
}

function RoleTag({ role }: { role: Role }) {
  return role === "owner" ? (
    <span className="tag pub">
      <Icon name="shield" size="sm" />
      Owner
    </span>
  ) : (
    <span className="tag">
      <Icon name="user" size="sm" />
      Staff
    </span>
  );
}

/** The prototype's row menu (`staffMenu`): edit, password reset, deactivate or reactivate. */
function RowMenu({
  staff,
  disabled,
  onEdit,
  onReset,
  onToggle,
}: {
  staff: Staff;
  disabled: boolean;
  onEdit: () => void;
  onReset: () => void;
  onToggle: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="ibtn"
        aria-label={`Actions for ${staff.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="more" />
      </button>
      <Pop
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        label={`Actions for ${staff.name}`}
        role="menu"
      >
        <div className="menu">
          <button type="button" role="menuitem" onClick={pick(onEdit)}>
            <Icon name="edit" />
            Edit
          </button>
          {staff.active && (
            <button type="button" role="menuitem" onClick={pick(onReset)}>
              <Icon name="mail" />
              Send password reset
            </button>
          )}
          <hr />
          <button
            type="button"
            role="menuitem"
            className={staff.active ? "danger" : undefined}
            onClick={pick(onToggle)}
          >
            <Icon name={staff.active ? "lock" : "check"} />
            {staff.active ? "Deactivate account" : "Reactivate account"}
          </button>
        </div>
      </Pop>
    </>
  );
}

type Run = Pick<
  ReturnType<typeof useManagementResource>,
  "run" | "disabled" | "message" | "busy" | "denied" | "reload"
>;

function RoleChoice({ name, defaultRole }: { name: string; defaultRole: Role }) {
  const [role, setRole] = useState<Role>(defaultRole);
  return (
    <div className="field">
      <span className="label">Role</span>
      <div className="radios">
        <label className="ropt">
          <input
            type="radio"
            name={name}
            value="staff"
            checked={role === "staff"}
            onChange={() => setRole("staff")}
          />
          <span>
            <b>Staff</b>
            <small>Orders, products, categories, brands, inventory and customer lookup.</small>
          </span>
        </label>
        <label className="ropt">
          <input
            type="radio"
            name={name}
            value="owner"
            checked={role === "owner"}
            onChange={() => setRole("owner")}
          />
          <span>
            <b>Owner</b>
            <small>Full access, including settings, exports and staff accounts.</small>
          </span>
        </label>
      </div>
      {role === "owner" && (
        <div className="note warn">
          <Icon name="alert" />
          <p>
            Owners can see revenue, export customer data and manage other accounts. Give this role
            only to business owners.
          </p>
        </div>
      )}
    </div>
  );
}

/** The prototype's Add staff drawer (`sfBody`): it queues an invitation by email. */
function InviteDrawer({
  resource,
  onClose,
  onQueued,
}: {
  resource: Run;
  onClose: () => void;
  onQueued: (queued: { id: string; expiresAt: string }) => void;
}) {
  const form = useId();
  return (
    <Drawer
      open
      onClose={onClose}
      title="Add staff member"
      sub="They get an email with a link to set their password"
      foot={
        <>
          <button type="button" className="btn btn-s" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={form} className="btn btn-p" disabled={resource.disabled}>
            <Icon name="send" />
            Send invite
          </button>
        </>
      }
    >
      <form
        id={form}
        className="form"
        data-unsaved="this invitation"
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
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
          if (outcome.ok) onQueued(outcome.value);
        }}
      >
        <ResourceNotice resource={resource} compact />
        <fieldset className="plain-fs form" disabled={resource.disabled}>
          <Fields
            fields={[
              { name: "name", label: "Full name", required: true, max: 100 },
              {
                name: "email",
                label: "Email",
                kind: "email",
                required: true,
                max: 254,
                help: "Used to sign in. Inviting the same email again replaces the pending link.",
              },
            ]}
            value={null}
          />
          <RoleChoice name="role" defaultRole="staff" />
          <p className="help">Email delivery depends on the configured sending domain.</p>
        </fieldset>
      </form>
    </Drawer>
  );
}

/** Edit a member: the profile and the role are separate commands, each with its version. */
function EditDrawer({
  staff,
  self,
  resource,
  onClose,
  onSaved,
}: {
  staff: Staff;
  self: boolean;
  resource: Run;
  onClose: () => void;
  onSaved: (next: Staff, what: string) => void;
}) {
  const profile = useId();
  const roleForm = useId();
  return (
    <Drawer
      open
      onClose={onClose}
      title="Edit staff member"
      sub={staff.email}
      foot={
        <button type="button" className="btn btn-s" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="stack">
        <ResourceNotice resource={resource} compact />
        <form
          id={profile}
          className="card pad form staff-group"
          data-unsaved={staff.name}
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const outcome = await resource.run((signal) =>
              managementRequest(
                `/staff/${staff.id}`,
                staffResponseSchema,
                "PATCH",
                validate(staffEditRequestSchema, {
                  version: staff.version,
                  name: String(data.get("name") ?? "").trim(),
                  email: String(data.get("email") ?? "").trim(),
                }),
                signal,
              ),
            );
            if (outcome.ok) onSaved(outcome.value, `${outcome.value.name} saved`);
          }}
        >
          <b>Profile</b>
          <fieldset className="plain-fs" disabled={resource.disabled}>
            <Fields
              fields={[
                { name: "name", label: "Full name", required: true, max: 100 },
                {
                  name: "email",
                  label: "Email",
                  kind: "email",
                  required: true,
                  max: 254,
                  help: self ? "Changing your own email signs you out." : undefined,
                },
              ]}
              value={staff}
            />
          </fieldset>
          <button type="submit" className="btn btn-p staff-save" disabled={resource.disabled}>
            Save profile
          </button>
        </form>
        <form
          id={roleForm}
          className="card pad form staff-group"
          data-unsaved={staff.name}
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            if (data.get("staff-role") === staff.role) {
              toast("The role is unchanged");
              return;
            }
            void confirmDialog({
              title: `Change ${staff.name}'s role?`,
              body: `Their sessions end and they sign in again.${self ? " You will be signed out." : ""}`,
              ok: "Change role",
            }).then(async (ok) => {
              if (!ok) return;
              const outcome = await resource.run((signal) =>
                managementRequest(
                  `/staff/${staff.id}/role`,
                  staffResponseSchema,
                  "POST",
                  validate(staffRoleRequestSchema, {
                    version: staff.version,
                    role: data.get("staff-role"),
                  }),
                  signal,
                ),
              );
              if (outcome.ok) onSaved(outcome.value, `${staff.name}'s role changed`);
            });
          }}
        >
          <fieldset className="plain-fs form" disabled={resource.disabled}>
            <RoleChoice name="staff-role" defaultRole={staff.role} />
          </fieldset>
          <button type="submit" className="btn btn-s staff-save" disabled={resource.disabled}>
            Change role
          </button>
        </form>
      </div>
    </Drawer>
  );
}
