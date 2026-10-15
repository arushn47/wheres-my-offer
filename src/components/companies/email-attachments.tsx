import { ChevronDown, FileSpreadsheet, FileText } from 'lucide-react';

function AttachmentName({ name }: { name: string }) {
  const Icon = /\.(xlsx?|csv|ods)$/i.test(name) ? FileSpreadsheet : FileText;
  return <>
    <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
    <span className="min-w-0 truncate text-zinc-300" title={name}>{name}</span>
  </>;
}

/** Native disclosure works with touch and keyboard, without another dialog. */
export function EmailAttachments({ names, alreadyShownName, testId }: { names: string[]; alreadyShownName?: string | null; testId?: string }) {
  const remaining = names.filter(name => name.toLowerCase() !== alreadyShownName?.toLowerCase());
  if (!remaining.length) return null;
  const rowClass = 'flex min-w-0 items-center gap-2 px-2.5 py-2 text-[10px] text-zinc-400';
  const containerClass = 'mt-2 min-w-0 rounded-lg border border-zinc-800/80 bg-zinc-900/40';
  if (remaining.length === 1) {
    return <div data-testid={testId} className={`${containerClass} ${rowClass}`}><AttachmentName name={remaining[0]} /></div>;
  }
  return (
    <details data-testid={testId} className={`${containerClass} group/attachments`}>
      <summary className={`${rowClass} cursor-pointer list-none rounded-lg hover:bg-zinc-800/30 focus-visible:outline-2 focus-visible:outline-emerald-400 [&::-webkit-details-marker]:hidden`}>
        <AttachmentName name={remaining[0]} />
        <span className="ml-auto flex shrink-0 items-center gap-1 text-zinc-400">
          +{remaining.length - 1} more
          <ChevronDown aria-hidden="true" className="h-3 w-3 transition-transform group-open/attachments:rotate-180" />
        </span>
      </summary>
      <ul className="border-t border-zinc-800/60">
        {remaining.slice(1).map((name, index) => (
          <li key={`${index}-${name}`} className={rowClass}><AttachmentName name={name} /></li>
        ))}
      </ul>
    </details>
  );
}
