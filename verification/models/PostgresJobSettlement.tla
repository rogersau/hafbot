------------------------ MODULE PostgresJobSettlement ------------------------
EXTENDS Naturals

CONSTANT KeepQueuedReason
VARIABLES state, attempts, reason, expectedReason, ready, operatorRetried

MaxAttempts == 2
Outcomes == {"complete", "rate-limited", "provider-unavailable", "invalid-payload"}

Init ==
    /\ state = "queued"
    /\ attempts = 0
    /\ reason = "none"
    /\ expectedReason = "none"
    /\ ready = TRUE
    /\ operatorRetried = FALSE

Claim ==
    /\ state = "queued" /\ ready /\ attempts < MaxAttempts
    /\ state' = "running"
    /\ attempts' = attempts + 1
    /\ UNCHANGED <<reason, expectedReason, ready, operatorRetried>>

ResultingState(outcome) ==
    CASE outcome = "complete" -> "completed"
      [] outcome = "invalid-payload" \/ attempts = MaxAttempts -> "terminal"
      [] OTHER -> "queued"

Settle(outcome) ==
    /\ state = "running"
    /\ state' = ResultingState(outcome)
    /\ expectedReason' = IF outcome = "complete" THEN "none" ELSE outcome
    /\ reason' = IF ~KeepQueuedReason /\ state' = "queued" THEN "none" ELSE expectedReason'
    /\ ready' = FALSE
    /\ UNCHANGED <<attempts, operatorRetried>>

BackoffElapsed ==
    /\ state = "queued" /\ ~ready
    /\ ready' = TRUE
    /\ UNCHANGED <<state, attempts, reason, expectedReason, operatorRetried>>

OperatorRetry ==
    /\ state = "terminal" /\ ~operatorRetried
    /\ state' = "queued"
    /\ attempts' = 0
    /\ reason' = "none"
    /\ expectedReason' = "none"
    /\ ready' = TRUE
    /\ operatorRetried' = TRUE

Next == Claim \/ BackoffElapsed \/ OperatorRetry \/ \E outcome \in Outcomes : Settle(outcome)

DurableSettlementReason == reason = expectedReason
=============================================================================
