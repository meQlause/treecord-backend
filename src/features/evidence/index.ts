export { evidenceRouter } from './evidence.routes.js';

// FR-117: the pipeline step S20 and S21 share
export { pipelineOf } from './evidence.mapper.js';

// read by planter's capture blocks (planter.md, evidence-prechecks §1 "Target"); B5b adds the evidence routes
export {
  currentMilestone,
  milestoneWindow,
  reasonsOf,
  targetChecks,
  type EvidenceKind,
  type TargetFacts,
} from './prechecks/prechecks.rules.js';
