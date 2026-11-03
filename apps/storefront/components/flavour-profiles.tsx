import type { FlavourProfile } from "@ih/contracts";

/** Filled dots out of `max`, read out as "3 of 5". */
function Gauge({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div className="fp-row">
      <dt>{label}</dt>
      <dd aria-label={`${value} of ${max}`}>
        <span className="fp-dots" aria-hidden="true">
          {Array.from({ length: max }, (_, index) => (
            <i key={index} className={index < value ? "on" : undefined} />
          ))}
        </span>
        <span className="fp-n">{value}</span>
      </dd>
    </div>
  );
}

/**
 * The taste of each flavour of a TEREA version (ADR 0103): body, intensity and cooling on the
 * store's scales, the click capsule and tasting notes. Only flavours still offered are shown, in
 * the order of the product's options.
 */
export function FlavourProfiles({
  profiles,
  offered,
}: {
  profiles: readonly FlavourProfile[];
  offered: readonly string[];
}) {
  const byName = new Map(profiles.map((profile) => [profile.flavour.toLowerCase(), profile]));
  const shown = offered
    .map((flavour) => byName.get(flavour.toLowerCase()))
    .filter((profile): profile is FlavourProfile => profile !== undefined);
  if (!shown.length) return null;
  return (
    <section aria-labelledby="taste-h" className="fp">
      <h2 className="h3 pdp-h" id="taste-h">
        Flavour profiles
      </h2>
      <ul className="fp-grid">
        {shown.map((profile) => (
          <li key={profile.flavour} className="fp-card">
            <h3 className="fp-name">
              {profile.flavour.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())}
              {profile.capsule && <span className="badge">Click capsule</span>}
            </h3>
            <dl>
              <Gauge label="Body" value={profile.body} max={5} />
              <Gauge label="Intensity" value={profile.intensity} max={5} />
              <Gauge label="Cooling" value={profile.cooling} max={5} />
            </dl>
            {profile.notes && <p className="fp-notes">{profile.notes}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
