export function requireFinalArchive(manifest, projectRef, now = Date.now()) {
  const age = now - Date.parse(manifest.createdAt);
  const pause = Date.parse(manifest.cutoverPauseVerifiedAt);
  if (manifest.projectRef !== projectRef || manifest.snapshotConsistent !== true ||
      manifest.writersDrainedAttested !== true || !Number.isFinite(pause) ||
      !Number.isFinite(age) || age < 0 || age > 30 * 60 * 1000 || pause > Date.parse(manifest.createdAt)) {
    throw new Error('A fresh paused cutover backup (under 30 minutes old) is required for each project');
  }
  if (!Array.isArray(manifest.files) || !['database.dump','roles.sql'].every(name=>manifest.files.some(file=>file.name===name && /^[a-f0-9]{64}$/.test(file.sha256)))) {
    throw new Error('Recovery archive manifest is incomplete');
  }
}
export function sequenceMatches(source, destination, allowHighWater = false) {
  if (source === destination) return true;
  if (!allowHighWater || !source || !destination) return false;
  const [a,calledA] = source.split(':'), [b,calledB] = destination.split(':');
  return /^\d+$/.test(a) && /^\d+$/.test(b) && ['true','false'].includes(calledA) &&
    ['true','false'].includes(calledB) && BigInt(b) >= BigInt(a) &&
    (calledA !== 'true' || calledB === 'true');
}
