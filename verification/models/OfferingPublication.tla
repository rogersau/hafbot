------------------------ MODULE OfferingPublication ------------------------
EXTENDS Naturals, FiniteSets

CONSTANT Mode
VARIABLES background, repair, drafts

Candidates == {"first", "second"}
Limit == 5

PublishedDrafts == Cardinality({id \in Candidates : drafts[id] = "published"})
ReservedRepairSlot == IF repair \in {"published", "repairing", "repaired"} THEN 1 ELSE 0
ReservedSlots == background + ReservedRepairSlot + PublishedDrafts

CountedSlots ==
    IF Mode = "OmitRepair" /\ repair = "repairing"
    THEN ReservedSlots - 1
    ELSE ReservedSlots

Init ==
    /\ background \in 3..4
    /\ repair \in {"published", "unpublished"}
    /\ drafts = [id \in Candidates |-> "draft"]

BeginRepair ==
    /\ repair \in {"published", "unpublished"}
    /\ repair' = IF repair = "published" THEN "repairing" ELSE "repairingUnpublished"
    /\ UNCHANGED <<background, drafts>>

CompleteRepair ==
    /\ repair \in {"repairing", "repairingUnpublished"}
    /\ repair' = IF repair = "repairing" THEN "repaired" ELSE "unpublished"
    /\ UNCHANGED <<background, drafts>>

CheckCapacity(id) ==
    /\ drafts[id] = "draft"
    /\ Mode = "SplitPublish" \/ \A other \in Candidates : drafts[other] # "checked"
    /\ CountedSlots < Limit
    /\ drafts' = [drafts EXCEPT ![id] = "checked"]
    /\ UNCHANGED <<background, repair>>

Publish(id) ==
    /\ drafts[id] = "checked"
    /\ drafts' = [drafts EXCEPT ![id] = "published"]
    /\ UNCHANGED <<background, repair>>

Next ==
    \/ BeginRepair
    \/ CompleteRepair
    \/ \E id \in Candidates : CheckCapacity(id) \/ Publish(id)

PublicationCapacity == ReservedSlots <= Limit
=============================================================================
