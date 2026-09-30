-- watch.sql: run as the read-only role (a member of switchyard_reader).

\echo '== Each unit: its status, and the end it reached'
SELECT unit_id, status, final_node_id, final_outcome
FROM switchyard.unit_status
ORDER BY unit_id;

\echo '== Where every unit is waiting (position 1 = next in that node''s queue)'
SELECT node_id, unit_id, state, queue_position AS position, node_kind, principal_id
FROM switchyard.unit_positions
ORDER BY node_id, position;

\echo '== The journey of each unit: every node it passed through, in order'
SELECT unit_id, enqueue_sequence AS seq, node_id, status, outcome,
       actor_id AS decided_by, attempts
FROM switchyard.turns
ORDER BY unit_id, enqueue_sequence;

\echo '== Decisions people made'
SELECT unit_id, node_id, outcome, actor_id, settled_at
FROM switchyard.human_decisions
ORDER BY decision_sequence;

\echo '== Replies a person accepted'
SELECT unit_id, payload ->> 'body' AS reply
FROM switchyard.unit_outputs
WHERE node_id = 'compose-reply::review' AND outcome = 'accepted:composed'
ORDER BY settlement_sequence;
