'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  MessageSquare,
  X,
  Send,
  Sparkles,
  Bot,
  User,
  CheckCircle2,
  Calendar,
  Building2,
  RefreshCw,
  Maximize2,
  Minimize2,
  Trash2,
  Clock,
  ArrowUpRight,
  TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { StatusChip } from '@/components/ui/status-chip';

interface ChatMessage {
  id: string;
  sender: 'user' | 'bot';
  text: string;
  timestamp: string;
}

const SUGGESTIONS = [
  'What are my upcoming tests?',
  'Show shortlisted companies',
  'What are my active pipeline drives?',
  'Sync with Google Calendar',
];

/**
 * Normalizes free-text status strings from LLM output into known StatusChip keys.
 */
function normalizeStatusKey(rawStatus: string): string {
  const clean = rawStatus.toLowerCase().replace(/[*_]/g, ' ').trim();
  if (clean.includes('shortlist') && !clean.includes('not')) return 'shortlisted';
  if (clean.includes('not shortlist')) return 'not_shortlisted';
  if (clean.includes('test') && (clean.includes('schedule') || clean.includes('round'))) return 'test_scheduled';
  if (clean.includes('test') && clean.includes('complete')) return 'test_completed';
  if (clean.includes('test') && (clean.includes('live') || clean.includes('ongoing'))) return 'test_ongoing';
  if (clean.includes('ppt') && clean.includes('schedule')) return 'ppt_scheduled';
  if (clean.includes('ppt') && clean.includes('complete')) return 'ppt_completed';
  if (clean.includes('ppt') && (clean.includes('live') || clean.includes('ongoing'))) return 'ppt_ongoing';
  if (clean.includes('interview') && clean.includes('schedule')) return 'interview_scheduled';
  if (clean.includes('interview') && clean.includes('complete')) return 'interview_completed';
  if (clean.includes('offer') || clean.includes('select')) return 'selected';
  if (clean.includes('reject') || clean.includes('eliminate')) return 'rejected';
  if (clean.includes('decline')) return 'declined';
  if (clean.includes('withdraw')) return 'withdrawn';
  if (clean.includes('applied')) return 'applied';
  return 'applied';
}

/**
 * Parses inline markdown: **bold**, *italic*, and `code`,
 * cleaning stray trailing asterisks often outputted by language models.
 */
function renderInlineMarkdown(text: string) {
  // Strip trailing asterisks attached to words (e.g., "Applied*" -> "Applied", "PM*" -> "PM")
  const cleanedText = text.replace(/([A-Za-z0-9])\*(?!\*)/g, '$1');

  // Split text by markdown patterns
  const parts = cleanedText.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/g);

  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="font-semibold text-text-primary">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return (
        <em key={i} className="italic text-text-secondary font-medium">
          {part.slice(1, -1)}
        </em>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="px-1.5 py-0.5 rounded bg-bg-surface border border-border-default/70 text-accent font-mono text-[10.5px]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

interface ParsedBlock {
  type: 'header' | 'metric_grid' | 'company_card' | 'bullet' | 'paragraph';
  content?: string;
  level?: number;
  metrics?: { label: string; value: string }[];
  company?: {
    name: string;
    driveNumber?: string;
    status?: string;
    details?: string;
    upcoming?: string;
  };
}

/**
 * Parses bot markdown text into structured semantic blocks (headers, metrics grid, company cards, lists).
 */
function parseBotMessage(text: string): ParsedBlock[] {
  const lines = text.split('\n');
  const blocks: ParsedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (!line) {
      i++;
      continue;
    }

    // 1. Headers: ### Header or ## Header
    const headerMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headerMatch) {
      blocks.push({
        type: 'header',
        level: headerMatch[1].length,
        content: headerMatch[2].trim(),
      });
      i++;
      continue;
    }

    // 2. Metric / Stats block: group consecutive lines matching "- Label: 123"
    const metricMatch = line.match(/^[-*•]?\s*(?:\*\*)?([A-Za-z\s/]+?)(?:\*\*)?\s*:\s*(?:\*\*)?(\d+)(?:\*\*)?\s*$/);
    if (metricMatch) {
      const metrics: { label: string; value: string }[] = [];
      while (i < lines.length) {
        const curLine = lines[i].trim();
        const mMatch = curLine.match(/^[-*•]?\s*(?:\*\*)?([A-Za-z\s/]+?)(?:\*\*)?\s*:\s*(?:\*\*)?(\d+)(?:\*\*)?\s*$/);
        if (mMatch) {
          metrics.push({ label: mMatch[1].trim(), value: mMatch[2].trim() });
          i++;
        } else {
          break;
        }
      }
      if (metrics.length > 0) {
        blocks.push({
          type: 'metric_grid',
          metrics,
        });
        continue;
      }
    }

    // 3. Company Card:
    // Pattern: "1. Chargebee (pat-PL-2026-1324) — Applied (Intern - Software Engineer | 16 LPA | Chennai)"
    // Or: "**Goldman Sachs** (pat-PL-2026-1262) — Test Scheduled (Seasonal Analyst...)"
    const companyCardMatch = line.match(
      /^(?:\d+[.)]\s*|[-*•]\s*)?(?:\*\*)?([A-Za-z0-9&.\s'-]+?)(?:\*\*)?\s*(?:\((pat-PL-[^)]+)\))?\s*[-—–]\s*(?:\*)?([A-Za-z0-9\s_·•.-]+?)(?:\*)?\s*(?:\(([^)]+)\))?\s*$/
    );

    if (
      companyCardMatch &&
      (companyCardMatch[2] ||
        /applied|shortlist|test|interview|offer|selected|rejected|decline|withdrawn|ppt/i.test(companyCardMatch[3]))
    ) {
      const name = companyCardMatch[1].trim();
      const driveNumber = companyCardMatch[2]?.trim();
      const status = companyCardMatch[3].trim().replace(/\*+$/, '');
      const details = companyCardMatch[4]?.trim();

      // Check if next line has upcoming info: e.g. "Upcoming: Registration Deadline..."
      let upcoming: string | undefined = undefined;
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        const upcomingMatch = nextLine.match(/^(?:[-*•]\s*)?Upcoming:\s*(.*)$/i);
        if (upcomingMatch) {
          upcoming = upcomingMatch[1].trim().replace(/\*+$/, '');
          i++; // Consume upcoming line
        }
      }

      blocks.push({
        type: 'company_card',
        company: {
          name,
          driveNumber,
          status,
          details,
          upcoming,
        },
      });
      i++;
      continue;
    }

    // 4. Bullet item: starts with - or * or •
    const bulletMatch = line.match(/^[-*•]\s+(.*)$/);
    if (bulletMatch) {
      blocks.push({
        type: 'bullet',
        content: bulletMatch[1].trim(),
      });
      i++;
      continue;
    }

    // 5. Default: Paragraph
    blocks.push({
      type: 'paragraph',
      content: line,
    });
    i++;
  }

  return blocks;
}

/**
 * Rich, styled UI view for Assistant responses with metrics cards and company drive chips.
 */
function BotMessageView({ text, onNavigate }: { text: string; onNavigate: (url: string) => void }) {
  const blocks = parseBotMessage(text);

  return (
    <div className="space-y-2">
      {blocks.map((block, idx) => {
        if (block.type === 'header') {
          return (
            <div
              key={idx}
              className="flex items-center gap-2 pt-2.5 pb-1 border-b border-border-default/50 mb-2 first:pt-0"
            >
              <span className="text-[13px] font-bold text-text-primary tracking-tight flex items-center gap-1.5">
                {block.content}
              </span>
            </div>
          );
        }

        if (block.type === 'metric_grid') {
          return (
            <div key={idx} className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 my-2.5">
              {block.metrics?.map((m, mIdx) => {
                const isZero = m.value === '0';
                return (
                  <div
                    key={mIdx}
                    className="px-3 py-2 rounded-xl bg-bg-surface/85 border border-border-default/70 flex flex-col justify-between shadow-2xs"
                  >
                    <span className="text-[9.5px] uppercase font-semibold tracking-wider text-text-tertiary truncate">
                      {m.label}
                    </span>
                    <span
                      className={cn(
                        'text-base sm:text-lg font-bold font-display mt-0.5 leading-none',
                        isZero ? 'text-text-tertiary' : 'text-emerald-400'
                      )}
                    >
                      {m.value}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        }

        if (block.type === 'company_card' && block.company) {
          const comp = block.company;
          return (
            <div
              key={idx}
              className="my-2 p-2.5 sm:p-3 rounded-xl bg-bg-surface/80 hover:bg-bg-surface border border-border-default/70 hover:border-border-default transition-all shadow-2xs group"
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-6 h-6 rounded-lg bg-accent/10 border border-accent/25 flex items-center justify-center text-accent shrink-0">
                    <Building2 className="w-3.5 h-3.5" />
                  </div>
                  <button
                    onClick={() => onNavigate(`/companies?q=${encodeURIComponent(comp.name)}`)}
                    className="font-bold text-text-primary hover:text-accent text-xs sm:text-[13px] truncate text-left cursor-pointer transition-colors flex items-center gap-1"
                    title={`View ${comp.name}`}
                  >
                    <span>{comp.name}</span>
                    <ArrowUpRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity text-accent shrink-0" />
                  </button>
                  {comp.driveNumber && (
                    <span className="px-1.5 py-0.5 rounded font-mono text-[9px] bg-bg-primary/90 border border-border-default text-text-secondary shrink-0">
                      {comp.driveNumber}
                    </span>
                  )}
                </div>
                {comp.status && (
                  <StatusChip status={normalizeStatusKey(comp.status)} size="sm" />
                )}
              </div>

              {comp.details && (
                <div className="mt-1.5 text-[11px] text-text-tertiary flex items-center gap-1.5 flex-wrap pl-8">
                  {comp.details.split('|').map((part, pIdx) => (
                    <span key={pIdx} className="inline-flex items-center gap-1.5">
                      {pIdx > 0 && <span className="text-text-tertiary/40">·</span>}
                      <span className={pIdx === 1 ? 'font-semibold text-text-secondary' : ''}>
                        {part.trim()}
                      </span>
                    </span>
                  ))}
                </div>
              )}

              {comp.upcoming && (
                <div className="mt-2.5 ml-8 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-300 text-[11px] flex items-start gap-1.5 leading-snug">
                  <Calendar className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <span>{renderInlineMarkdown(comp.upcoming)}</span>
                </div>
              )}
            </div>
          );
        }

        if (block.type === 'bullet') {
          return (
            <div key={idx} className="flex items-start gap-2 my-1 pl-1 text-xs text-text-secondary leading-relaxed">
              <span className="w-1.5 h-1.5 rounded-full bg-accent/70 shrink-0 mt-1.5" />
              <div className="flex-1">{renderInlineMarkdown(block.content || '')}</div>
            </div>
          );
        }

        return (
          <p key={idx} className="my-1.5 text-xs text-text-secondary leading-relaxed">
            {renderInlineMarkdown(block.content || '')}
          </p>
        );
      })}
    </div>
  );
}

export default function ChatAssistant() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'bot',
      text: "👋 Hi! I'm your Placement Assistant. Ask me anything about your pipeline (e.g. **What are my active pipeline drives?**), check CTCs, or update application statuses!",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  const handleSendMessage = async (textToSend?: string) => {
    const messageText = textToSend || input;
    if (!messageText.trim() || loading) return;

    const userMsg: ChatMessage = {
      id: String(Date.now()),
      sender: 'user',
      text: messageText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!textToSend) setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: messageText }),
      });

      const data = await res.json();
      const botMsg: ChatMessage = {
        id: String(Date.now() + 1),
        sender: 'bot',
        text: data.reply || "I couldn't process that request. Please try again!",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages((prev) => [...prev, botMsg]);

      // If status or event was updated, trigger instant state refresh across the UI
      if (data.action === 'status_updated' || data.action === 'event_added') {
        window.dispatchEvent(new Event('placement_status_updated'));
        router.refresh();
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: String(Date.now() + 1),
          sender: 'bot',
          text: '⚠️ Something went wrong connecting to the assistant. Please try again.',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleClearChat = () => {
    setMessages([
      {
        id: 'welcome',
        sender: 'bot',
        text: "👋 Hi! I'm your Placement Assistant. Ask me anything about your pipeline (e.g. **What are my active pipeline drives?**), check CTCs, or update application statuses!",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  return (
    <>
      {/* Floating Chat Button — positioned above mobile nav */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'fixed bottom-20 right-3.5 sm:right-4 lg:bottom-6 lg:right-6 z-40 p-3 sm:p-3.5 rounded-2xl shadow-xl flex items-center justify-center transition-all duration-300 group cursor-pointer',
          isOpen
            ? 'bg-bg-elevated border border-border-default text-text-primary scale-90'
            : 'bg-gradient-to-tr from-accent to-accent-hover text-white shadow-accent/25 hover:scale-105 hover:shadow-2xl'
        )}
        aria-label="Open Placement Assistant"
      >
        {isOpen ? (
          <X className="w-5.5 h-5.5 sm:w-6 sm:h-6" />
        ) : (
          <div className="relative">
            <Bot className="w-5.5 h-5.5 sm:w-6 sm:h-6 group-hover:rotate-6 transition-transform" />
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-400 rounded-full border-2 border-bg-surface ring-2 ring-emerald-400/30" />
          </div>
        )}
      </button>

      {/* Chat Drawer Window — full-width on mobile, resizable / expandable on desktop */}
      {isOpen && (
        <div
          className={cn(
            'fixed bottom-[4.5rem] sm:bottom-20 right-2 left-2 lg:bottom-20 lg:right-6 lg:left-auto z-50 bg-bg-surface/95 backdrop-blur-xl border border-border-default rounded-3xl shadow-2xl flex flex-col overflow-hidden transition-all duration-300 animate-fade-in max-h-[calc(100dvh-5.5rem)]',
            isExpanded
              ? 'lg:w-[660px] h-[min(720px,85vh)]'
              : 'lg:w-[440px] h-[min(560px,72vh)]'
          )}
        >
          {/* Drawer Header */}
          <div className="flex items-center justify-between px-5 py-4 bg-bg-elevated/80 border-b border-border-default">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
                <Sparkles className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-text-primary">Placement Assistant</h3>
                <p className="text-[11px] text-text-tertiary flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                  Online · Powered by Gemini
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={handleClearChat}
                className="p-1.5 rounded-lg text-text-tertiary hover:text-rose-400 hover:bg-bg-surface-hover transition-colors cursor-pointer"
                title="Clear conversation"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="p-1.5 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors hidden sm:flex items-center justify-center cursor-pointer"
                title={isExpanded ? 'Collapse window size' : 'Expand window size'}
              >
                {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors cursor-pointer"
                title="Close Assistant"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Messages Feed */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  'flex gap-2.5 text-xs',
                  msg.sender === 'user' ? 'justify-end' : 'justify-start'
                )}
              >
                {msg.sender === 'bot' && (
                  <div className="w-6 h-6 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center text-accent flex-shrink-0 mt-1">
                    <Bot className="w-3.5 h-3.5" />
                  </div>
                )}

                <div
                  className={cn(
                    'px-3.5 py-2.5 rounded-2xl shadow-sm text-xs transition-all',
                    msg.sender === 'user'
                      ? 'max-w-[82%] bg-accent text-white rounded-br-none font-medium ml-auto whitespace-pre-wrap leading-relaxed'
                      : 'max-w-[92%] sm:max-w-[88%] bg-bg-elevated/90 border border-border-default/90 text-text-primary rounded-bl-none'
                  )}
                >
                  {msg.sender === 'user' ? (
                    <div>{msg.text}</div>
                  ) : (
                    <BotMessageView text={msg.text} onNavigate={(url) => router.push(url)} />
                  )}
                  <span
                    className={cn(
                      'block text-[9px] mt-1.5 text-right font-medium',
                      msg.sender === 'user' ? 'text-white/70' : 'text-text-tertiary'
                    )}
                  >
                    {msg.timestamp}
                  </span>
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex gap-2.5 text-xs justify-start items-center">
                <div className="w-6 h-6 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center text-accent flex-shrink-0">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                </div>
                <div className="px-3.5 py-2 rounded-xl bg-bg-elevated border border-border-default/80 text-text-tertiary text-xs flex items-center gap-1.5">
                  <span>Assistant is thinking...</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Suggestion Chips */}
          <div className="px-3 py-2 border-t border-border-default/40 bg-bg-elevated/30 flex items-center gap-1.5 overflow-x-auto scrollbar-none">
            {SUGGESTIONS.map((s, i) => (
              <button
                key={i}
                onClick={() => handleSendMessage(s)}
                className="px-2.5 py-1 rounded-lg text-[10.5px] font-medium bg-bg-surface hover:bg-bg-surface-hover text-text-secondary hover:text-text-primary border border-border-default whitespace-nowrap transition-all cursor-pointer shadow-2xs"
              >
                {s}
              </button>
            ))}
          </div>

          {/* Message Input Box */}
          <div className="p-3 bg-bg-elevated/80 border-t border-border-default flex items-center gap-2">
            <input
              type="text"
              placeholder="Tell me to update status or ask a question..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
              className="flex-1 px-3.5 py-2 bg-bg-surface border border-border-default rounded-xl text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-all"
            />
            <button
              onClick={() => handleSendMessage()}
              disabled={!input.trim() || loading}
              className="p-2 rounded-xl bg-accent hover:bg-accent-hover text-white disabled:opacity-40 transition-all flex-shrink-0 cursor-pointer disabled:cursor-not-allowed shadow-sm"
              aria-label="Send message"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
