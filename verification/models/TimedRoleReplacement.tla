------------------------ MODULE TimedRoleReplacement -------------------------
CONSTANT Transactional
VARIABLES rules, phase

Writers == {"first", "second"}
Requested == [writer \in Writers |-> IF writer = "first" THEN {"a", "b"} ELSE {"c", "d"}]

Init ==
    /\ rules = {}
    /\ phase = [writer \in Writers |-> "ready"]

DeleteRules(writer) ==
    /\ phase[writer] = "ready"
    /\ ~Transactional \/ \A other \in Writers : phase[other] # "writing"
    /\ phase' = [phase EXCEPT ![writer] = "writing"]
    /\ rules' = IF Transactional THEN rules ELSE {}

InsertRules(writer) ==
    /\ phase[writer] = "writing"
    /\ phase' = [phase EXCEPT ![writer] = "committed"]
    /\ rules' = IF Transactional THEN Requested[writer] ELSE rules \cup Requested[writer]

Next == \E writer \in Writers : DeleteRules(writer) \/ InsertRules(writer)

CommittedRulesAreWhole == rules = {} \/ \E writer \in Writers : rules = Requested[writer]
=============================================================================
