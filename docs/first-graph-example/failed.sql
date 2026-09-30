-- failed.sql: the units that failed, where and why, and the text they had.
-- Run as the read-only role (a member of switchyard_reader).
SELECT status.unit_id, status.graph_version AS version, failure.node_id,
       failure.error_code, failure.error_message,
       seed.envelope::jsonb #>> '{payload,text}' AS text
FROM switchyard.unit_status AS status
JOIN switchyard.turn_failures AS failure
  ON failure.unit_id = status.unit_id AND failure.terminal
JOIN switchyard.units AS unit ON unit.unit_id = status.unit_id
JOIN switchyard.artifacts AS seed
  ON seed.contract_id = unit.seed_contract_id
 AND seed.artifact_digest = unit.seed_artifact_digest
WHERE status.status = 'failed'
ORDER BY failure.failed_at;
