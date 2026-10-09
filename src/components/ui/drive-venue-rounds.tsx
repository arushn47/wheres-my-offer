import type { DriveModeRound } from '@/lib/drive-venues';
import { DriveModeBadge } from './drive-mode-badge';

export function DriveVenueRounds({ rounds }: { rounds: DriveModeRound[] }) {
  return (
    <section aria-label="Round venues" className="mt-5 border-t border-zinc-800/70 pt-4">
      <h3 className="mb-2.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Round venues</h3>
      {rounds.length ? (
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Recruitment attendance by round</caption>
          <thead className="text-[10px] text-zinc-500">
            <tr><th scope="col" className="pb-2 font-medium">Round</th><th scope="col" className="px-3 pb-2 font-medium">Mode</th><th scope="col" className="pb-2 font-medium">Venue</th></tr>
          </thead>
          <tbody>
            {rounds.map(round => (
              <tr key={`${round.stage}:${round.mode}:${round.venue}`} className="border-t border-zinc-800/50">
                <th scope="row" className="py-2.5 align-top font-medium text-zinc-300">{round.stage}</th>
                <td className="px-3 py-2.5 align-top"><DriveModeBadge driveMode={round.mode} requiresTravel={round.requiresTravel} className="w-fit whitespace-nowrap" /></td>
                <td className="break-words py-2.5 align-top text-zinc-300">{round.venue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="text-xs text-zinc-500">Attendance mode or venue has not been confirmed.</p>}
    </section>
  );
}
