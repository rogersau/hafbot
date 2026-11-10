// PROTOTYPE — three review lenses for a draft contract, not production UI.
import { useMemo, useState } from "react";
import { VariantSwitcher, type VariantMeta } from "../components/VariantSwitcher";
import {
  contractsForGoal,
  FEATURE_ONBOARDING_CONTRACTS,
  goalMeta,
  ONBOARDING_GOALS,
  type FeatureOnboardingContract,
  type OnboardingGoalKey,
} from "./contract";

const VARIANTS: VariantMeta[] = [
  {
    key: "A",
    name: "Goal journey",
    blurb: "Test recommendations from an admin outcome",
  },
  {
    key: "B",
    name: "Feature matrix",
    blurb: "Compare coverage and consistency",
  },
  {
    key: "C",
    name: "Contract inspector",
    blurb: "Review one feature and its raw declaration",
  },
];

type Verdict = "undecided" | "approve" | "revise";

interface ReviewState {
  verdict: Verdict;
  overallNotes: string;
  goalNotes: Partial<Record<OnboardingGoalKey, string>>;
  featureNotes: Record<string, string>;
}

const INITIAL_REVIEW: ReviewState = {
  verdict: "undecided",
  overallNotes: "",
  goalNotes: {},
  featureNotes: {},
};

function readVariant() {
  const requested = new URLSearchParams(window.location.search).get("variant") ?? "A";
  return VARIANTS.some((variant) => variant.key === requested) ? requested : "A";
}

function formatToken(value: string) {
  return value.replaceAll("_", " ");
}

function ContractBadges({ contract }: { contract: FeatureOnboardingContract }) {
  return (
    <div className="badges" aria-label="Contract characteristics">
      <span>{formatToken(contract.availability)}</span>
      <span>{contract.setup.experience}</span>
      <span>
        {contract.setup.estimatedMinutes[0]}–{contract.setup.estimatedMinutes[1]} min
      </span>
      <span>{formatToken(contract.setup.resourceSetup)} resources</span>
    </div>
  );
}

function GoalJourney({
  selectedGoal,
  onGoalChange,
  onInspect,
}: {
  selectedGoal: OnboardingGoalKey;
  onGoalChange: (goal: OnboardingGoalKey) => void;
  onInspect: (featureKey: string) => void;
}) {
  const goal = goalMeta(selectedGoal);
  const contracts = contractsForGoal(selectedGoal);
  const lead = contracts[0];

  return (
    <section className="lens goal-lens" aria-labelledby="goal-heading">
      <div className="lens-heading">
        <p className="eyebrow">Lens A · Recommendation behavior</p>
        <h2 id="goal-heading">What does this Guild want to accomplish first?</h2>
        <p>
          Choose an outcome and challenge the order, rationale, effort, and definition of success.
        </p>
      </div>

      <div className="goal-picker" role="group" aria-label="Onboarding goal">
        {ONBOARDING_GOALS.map((candidate) => (
          <button
            type="button"
            className={candidate.key === selectedGoal ? "is-selected" : ""}
            key={candidate.key}
            onClick={() => onGoalChange(candidate.key)}
          >
            <strong>{candidate.label}</strong>
            <span>{candidate.prompt}</span>
          </button>
        ))}
      </div>

      <div className="journey-context">
        <span>Selected goal</span>
        <strong>{goal.label}</strong>
        <span>{contracts.length} relevant features</span>
        <span>First success: {goal.firstSuccess}</span>
      </div>

      {lead && (
        <article className="recommendation-card recommendation-card--lead">
          <div>
            <p className="eyebrow">Recommended starting point</p>
            <h3>{lead.label}</h3>
            <p className="lead-copy">{lead.summary}</p>
            <p className="reason">{lead.goals.find((item) => item.key === selectedGoal)?.reason}</p>
            <ContractBadges contract={lead} />
          </div>
          <div className="success-box">
            <span>Feature-owned verification</span>
            <strong>{lead.verification?.label ?? "Not yet defined"}</strong>
            <p>{lead.verification?.successEvidence ?? "This gap needs a contract decision."}</p>
            <button type="button" onClick={() => onInspect(lead.featureKey)}>
              Inspect contract
            </button>
          </div>
        </article>
      )}

      <div className="recommendation-list">
        {contracts.slice(1).map((contract, index) => {
          const relevance = contract.goals.find((item) => item.key === selectedGoal)!;
          return (
            <article className="recommendation-card" key={contract.featureKey}>
              <div className="recommendation-rank">{String(index + 2).padStart(2, "0")}</div>
              <div>
                <div className="card-title-row">
                  <h3>{contract.label}</h3>
                  <span className={`relevance relevance--${relevance.relevance}`}>
                    {relevance.relevance}
                  </span>
                </div>
                <p>{relevance.reason}</p>
                <ContractBadges contract={contract} />
              </div>
              <button
                className="text-button"
                type="button"
                onClick={() => onInspect(contract.featureKey)}
              >
                Inspect →
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function FeatureMatrix({ onInspect }: { onInspect: (featureKey: string) => void }) {
  const [query, setQuery] = useState("");
  const [experience, setExperience] = useState("all");
  const filtered = FEATURE_ONBOARDING_CONTRACTS.filter((contract) => {
    const matchesQuery = `${contract.label} ${contract.summary}`
      .toLowerCase()
      .includes(query.toLowerCase());
    return matchesQuery && (experience === "all" || contract.setup.experience === experience);
  });

  return (
    <section className="lens matrix-lens" aria-labelledby="matrix-heading">
      <div className="lens-heading lens-heading--split">
        <div>
          <p className="eyebrow">Lens B · Coverage audit</p>
          <h2 id="matrix-heading">Does every feature tell the orchestrator enough?</h2>
          <p>
            Scan all declarations for gaps, suspicious estimates, and inconsistent setup postures.
          </p>
        </div>
        <div className="matrix-stats">
          <strong>{FEATURE_ONBOARDING_CONTRACTS.length}</strong>
          <span>feature contracts</span>
        </div>
      </div>

      <div className="filters">
        <label>
          Search
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Feature or purpose"
          />
        </label>
        <label>
          Setup experience
          <select value={experience} onChange={(event) => setExperience(event.target.value)}>
            <option value="all">All experiences</option>
            <option value="guided">Guided</option>
            <option value="focused">Focused</option>
            <option value="expert">Expert</option>
          </select>
        </label>
      </div>

      <div className="matrix-wrap">
        <table>
          <thead>
            <tr>
              <th>Feature</th>
              <th>Goals</th>
              <th>Availability</th>
              <th>Setup</th>
              <th>Resources</th>
              <th>Verification</th>
              <th>Questions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((contract) => (
              <tr key={contract.featureKey}>
                <td>
                  <button
                    className="feature-link"
                    type="button"
                    onClick={() => onInspect(contract.featureKey)}
                  >
                    {contract.label}
                  </button>
                  <small>{contract.featureKey}</small>
                </td>
                <td>{contract.goals.map((goal) => goalMeta(goal.key).label).join(", ")}</td>
                <td>{formatToken(contract.availability)}</td>
                <td>
                  {contract.setup.experience} · {contract.setup.estimatedMinutes.join("–")} min
                </td>
                <td>{formatToken(contract.setup.resourceSetup)}</td>
                <td className={contract.verification ? "" : "cell-warning"}>
                  {contract.verification?.label ?? "Missing"}
                </td>
                <td className={contract.openQuestions.length ? "cell-warning" : ""}>
                  {contract.openQuestions.length}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="result-count">Showing {filtered.length} contracts.</p>
    </section>
  );
}

function ContractInspector({
  selectedFeatureKey,
  onFeatureChange,
}: {
  selectedFeatureKey: string;
  onFeatureChange: (featureKey: string) => void;
}) {
  const contract = FEATURE_ONBOARDING_CONTRACTS.find(
    (item) => item.featureKey === selectedFeatureKey,
  )!;

  return (
    <section className="lens inspector-lens" aria-labelledby="inspector-heading">
      <div className="lens-heading">
        <p className="eyebrow">Lens C · Feature ownership</p>
        <h2 id="inspector-heading">Can this declaration stand on its own?</h2>
        <p>
          Review what one feature promises without letting the orchestrator own its setup logic.
        </p>
      </div>

      <div className="inspector-grid">
        <nav className="feature-nav" aria-label="Feature contracts">
          {FEATURE_ONBOARDING_CONTRACTS.map((candidate) => (
            <button
              type="button"
              className={candidate.featureKey === selectedFeatureKey ? "is-selected" : ""}
              key={candidate.featureKey}
              onClick={() => onFeatureChange(candidate.featureKey)}
            >
              <span>{candidate.label}</span>
              <small>{candidate.openQuestions.length} open</small>
            </button>
          ))}
        </nav>

        <article className="contract-detail">
          <div className="contract-title">
            <div>
              <p className="eyebrow">{contract.featureKey}</p>
              <h3>{contract.label}</h3>
              <p>{contract.summary}</p>
            </div>
            <ContractBadges contract={contract} />
          </div>

          <div className="contract-fields">
            <div>
              <span>Setup entry</span>
              <strong>{contract.setup.entryPath}</strong>
            </div>
            <div>
              <span>Readiness source</span>
              <strong>{contract.readinessKey}</strong>
            </div>
            <div>
              <span>Defaults posture</span>
              <strong>{contract.setup.defaults}</strong>
            </div>
            <div>
              <span>Verification kind</span>
              <strong>{formatToken(contract.verification?.kind ?? "missing")}</strong>
            </div>
          </div>

          <section className="detail-section">
            <h4>Goal relevance</h4>
            {contract.goals.map((goal) => (
              <div className="goal-reason" key={goal.key}>
                <span>{goalMeta(goal.key).label}</span>
                <strong>
                  #{goal.recommendationPriority} · {goal.relevance}
                </strong>
                <p>{goal.reason}</p>
              </div>
            ))}
          </section>

          <section className="detail-section">
            <h4>First-success verification</h4>
            {contract.verification ? (
              <div className="verification-detail">
                <strong>{contract.verification.label}</strong>
                <p>{contract.verification.successEvidence}</p>
              </div>
            ) : (
              <p className="missing-callout">No verification has been defined.</p>
            )}
          </section>

          <section className="detail-section">
            <h4>Open questions</h4>
            {contract.openQuestions.length ? (
              <ul>
                {contract.openQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            ) : (
              <p>No questions recorded in this draft.</p>
            )}
          </section>

          <details className="raw-contract">
            <summary>View raw contract JSON</summary>
            <pre>{JSON.stringify(contract, null, 2)}</pre>
          </details>
        </article>
      </div>
    </section>
  );
}

function ReviewPanel({
  review,
  onReviewChange,
  selectedGoal,
  selectedFeatureKey,
  variant,
}: {
  review: ReviewState;
  onReviewChange: (review: ReviewState) => void;
  selectedGoal: OnboardingGoalKey;
  selectedFeatureKey: string;
  variant: string;
}) {
  const [copied, setCopied] = useState(false);
  const exportValue = useMemo(
    () => JSON.stringify({ schemaVersion: 1, reviewedVariant: variant, ...review }, null, 2),
    [review, variant],
  );
  const contextNote =
    variant === "A"
      ? (review.goalNotes[selectedGoal] ?? "")
      : (review.featureNotes[selectedFeatureKey] ?? "");
  const contextLabel =
    variant === "A"
      ? `Notes on “${goalMeta(selectedGoal).label}”`
      : `Notes on ${FEATURE_ONBOARDING_CONTRACTS.find((item) => item.featureKey === selectedFeatureKey)?.label}`;

  const updateContextNote = (value: string) => {
    if (variant === "A") {
      onReviewChange({ ...review, goalNotes: { ...review.goalNotes, [selectedGoal]: value } });
      return;
    }
    onReviewChange({
      ...review,
      featureNotes: { ...review.featureNotes, [selectedFeatureKey]: value },
    });
  };

  const copyReview = async () => {
    await navigator.clipboard.writeText(exportValue);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <aside className="review-panel" aria-labelledby="review-heading">
      <div>
        <p className="eyebrow">Your review · kept in this tab only</p>
        <h2 id="review-heading">Is this the right contract?</h2>
      </div>
      <div className="verdicts" role="group" aria-label="Overall verdict">
        {(["undecided", "approve", "revise"] as Verdict[]).map((verdict) => (
          <button
            type="button"
            className={review.verdict === verdict ? "is-selected" : ""}
            key={verdict}
            onClick={() => onReviewChange({ ...review, verdict })}
          >
            {verdict}
          </button>
        ))}
      </div>
      <label>
        Overall notes
        <textarea
          rows={4}
          value={review.overallNotes}
          onChange={(event) => onReviewChange({ ...review, overallNotes: event.target.value })}
          placeholder="What should change before implementation?"
        />
      </label>
      <label>
        {contextLabel}
        <textarea
          rows={4}
          value={contextNote}
          onChange={(event) => updateContextNote(event.target.value)}
          placeholder="Capture a specific recommendation, field, or wording change."
        />
      </label>
      <div className="review-actions">
        <button type="button" className="copy-button" onClick={copyReview}>
          {copied ? "Copied review" : "Copy review JSON"}
        </button>
        <details>
          <summary>Preview response</summary>
          <pre>{exportValue}</pre>
        </details>
      </div>
    </aside>
  );
}

export function App() {
  const [variant, setVariant] = useState(readVariant);
  const [selectedGoal, setSelectedGoal] = useState<OnboardingGoalKey>("protect_community");
  const [selectedFeatureKey, setSelectedFeatureKey] = useState("reaction-rules");
  const [review, setReview] = useState<ReviewState>(INITIAL_REVIEW);

  const changeVariant = (key: string) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("variant", key);
    window.history.replaceState({}, "", nextUrl);
    setVariant(key);
  };

  const inspectFeature = (featureKey: string) => {
    setSelectedFeatureKey(featureKey);
    changeVariant("C");
  };

  return (
    <div className="review-app">
      <header className="site-header">
        <a className="brand" href="?variant=A" aria-label="HAF onboarding contract review home">
          <img src="/logo.png" alt="" />
          <span>HAF Bot</span>
        </a>
        <div>
          <span className="prototype-label">Review prototype</span>
          <span className="draft-label">Contract draft · not production UI</span>
        </div>
      </header>

      <main>
        <section className="intro">
          <p className="eyebrow">Feature Onboarding Contract</p>
          <h1>Define what every feature owes the onboarding orchestrator.</h1>
          <p>
            The orchestrator may recommend, sequence, and report readiness. Each feature still owns
            its setup entry, resource creation, readiness, and proof of first success.
          </p>
        </section>

        <div className="workspace">
          <div className="lens-container">
            {variant === "A" && (
              <GoalJourney
                selectedGoal={selectedGoal}
                onGoalChange={setSelectedGoal}
                onInspect={inspectFeature}
              />
            )}
            {variant === "B" && <FeatureMatrix onInspect={inspectFeature} />}
            {variant === "C" && (
              <ContractInspector
                selectedFeatureKey={selectedFeatureKey}
                onFeatureChange={setSelectedFeatureKey}
              />
            )}
          </div>
          <ReviewPanel
            review={review}
            onReviewChange={setReview}
            selectedGoal={selectedGoal}
            selectedFeatureKey={selectedFeatureKey}
            variant={variant}
          />
        </div>
      </main>

      <VariantSwitcher variants={VARIANTS} current={variant} onChange={changeVariant} />
    </div>
  );
}
