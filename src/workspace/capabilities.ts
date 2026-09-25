import { offlineWriteLimitations } from './offlineWrite.js';

export function workspaceCapabilities() {
  return {
    solutionMembership: { status: 'supported', formats: ['sln', 'slnx'], mode: 'server-side literal file inspection' },
    projectInspection: { status: 'supported', mode: 'literal XML only; imports/SDK/dynamic Model evaluation unsupported' },
    offlineWrites: { status: 'supported', mode: 'allowlisted existing model, preview then explicit acknowledged apply' },
    nativeIdeBridge: { status: 'unavailable', liveVisualStudioState: false, unsavedEditsVisible: false },
    compiler: { status: 'notRun', validated: false },
    dependencies: { status: 'notEvaluated', note: 'Descriptor references are reported, not compiler-verified.' },
    crashRecovery: { status: 'manualOnly', mode: 'bounded journal/backups, retained locks block subsequent writes' },
    limitations: offlineWriteLimitations,
  };
}

export function metadataProvenance(customMetadataDir: string | undefined, projectDir: string | undefined) {
  return {
    configuredPath: customMetadataDir || projectDir || null,
    source: customMetadataDir ? 'D365_CUSTOM_METADATA_DIR'
      : projectDir ? 'D365_PROJECT_DIR (legacy alias)' : 'unconfigured',
  };
}
