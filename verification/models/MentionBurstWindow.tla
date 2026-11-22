------------------------- MODULE MentionBurstWindow -------------------------
EXTENDS Naturals

CONSTANT SharedGuildLock
VARIABLES replacement, window, phase, expectedFresh, observed

Members == {"first", "second"}

Init ==
    /\ replacement = "idle"
    /\ window = [user \in Members |-> 1]
    /\ phase = [user \in Members |-> "idle"]
    /\ expectedFresh = [user \in Members |-> FALSE]
    /\ observed = [user \in Members |-> 0]

BeginReplacement ==
    /\ replacement = "idle"
    /\ ~SharedGuildLock \/ \A user \in Members : phase[user] # "recording"
    /\ replacement' = "replacing"
    /\ UNCHANGED <<window, phase, expectedFresh, observed>>

CommitReplacement ==
    /\ replacement = "replacing"
    /\ replacement' = "committed"
    /\ window' = [user \in Members |-> 0]
    /\ UNCHANGED <<phase, expectedFresh, observed>>

RequestRecording(user) ==
    /\ phase[user] = "idle"
    /\ phase' = [phase EXCEPT ![user] = "waiting"]
    /\ expectedFresh' = [expectedFresh EXCEPT ![user] = (replacement # "idle")]
    /\ UNCHANGED <<replacement, window, observed>>

BeginRecording(user) ==
    /\ phase[user] = "waiting"
    /\ ~SharedGuildLock \/ replacement # "replacing"
    /\ phase' = [phase EXCEPT ![user] = "recording"]
    /\ UNCHANGED <<replacement, window, expectedFresh, observed>>

CommitRecording(user) ==
    /\ phase[user] = "recording"
    /\ window' = [window EXCEPT ![user] = @ + 1]
    /\ observed' = [observed EXCEPT ![user] = window'[user]]
    /\ phase' = [phase EXCEPT ![user] = "committed"]
    /\ UNCHANGED <<replacement, expectedFresh>>

Next ==
    \/ BeginReplacement
    \/ CommitReplacement
    \/ \E user \in Members :
        RequestRecording(user) \/ BeginRecording(user) \/ CommitRecording(user)

FreshWindowCounts ==
    \A user \in Members :
        (expectedFresh[user] /\ phase[user] = "committed")
        => (observed[user] = 1 /\ window[user] = 1)
=============================================================================
