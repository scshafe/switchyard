-- watch.sql: run as the read-only role (a member of switchyard_reader).

\echo '== Where every unit is waiting (position 1 = next in that node''s queue)'
SELECT node_id, unit_id, status,
       rank() OVER (PARTITION BY node_id ORDER BY enqueue_sequence) AS position,
       node_kind, principal_id
FROM switchyard.turns
WHERE status IN ('queued', 'leased')
ORDER BY node_id, position;

\echo '== The journey of each unit: every node it passed through, in order'
SELECT unit_id, enqueue_sequence AS seq, node_id, status, outcome,
       actor_id AS decided_by, attempts
FROM switchyard.turns
ORDER BY unit_id, enqueue_sequence;

\echo '== Each unit''s state and its last step'
SELECT unit_id,
       CASE WHEN bool_or(status IN ('queued', 'leased')) THEN 'in progress'
            WHEN bool_or(status = 'failed') THEN 'failed'
            ELSE 'finished' END AS state,
       (array_agg(node_id || ' -> ' || coalesce(outcome, error_code, status)
                  ORDER BY enqueue_sequence DESC))[1] AS last_step
FROM switchyard.turns
GROUP BY unit_id
ORDER BY unit_id;

\echo '== Decisions people made'
SELECT unit_id, node_id, outcome, actor_id, settled_at
FROM switchyard.human_decisions
ORDER BY decision_sequence;

\echo '== Replies a person accepted'
SELECT settlement.unit_id,
       artifact.envelope::json #>> '{payload,body}' AS reply
FROM switchyard.turn_settlements AS settlement
JOIN switchyard.artifacts AS artifact
  ON artifact.contract_id = settlement.output_contract_id
 AND artifact.artifact_digest = settlement.output_artifact_digest
WHERE settlement.node_id = 'compose-reply::review'
  AND settlement.outcome = 'accepted:composed'
ORDER BY settlement.settlement_sequence;
