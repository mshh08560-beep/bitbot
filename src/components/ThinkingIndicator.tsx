import React, { useState, useEffect } from 'react';
import { Sparkles, Zap, Terminal } from 'lucide-react';

const SARCASTIC_THOUGHTS = [
  'טוען מנת סרקזם מרוכזת...',
  'מנסח תשובה חדה כתער...',
  'מעבד את השאלה המיותרת שלך...',
  'מחפש סימני אינטליגנציה... מתאמץ ממש...',
  'מחמם מעבדים לרמת ציניות מקסימלית...',
  'סורק את הטיעון השבור שלך...',
  'מתאפק לא לצחוק בקול רם...',
  'מכין ירידה שלא תתאושש ממנה...',
  'מתלבט אם לענות ברצינות או לצחוק עליך...',
];

export const ThinkingIndicator: React.FC = () => {
  const [thoughtIndex, setThoughtIndex] = useState(0);
  const [fade, setFade] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setThoughtIndex((prev) => (prev + 1) % SARCASTIC_THOUGHTS.length);
        setFade(true);
      }, 180);
    }, 1700);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col items-start py-2 select-none">
      <div className="relative overflow-hidden rounded-2xl rounded-bl-xs bg-zinc-950 text-white px-4 py-3 shadow-lg border border-zinc-800/80 flex items-center gap-3.5 max-w-[90%] sm:max-w-[80%]">
        {/* Shimmering scanning beam effect */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl">
          <div
            className="w-1/2 h-full bg-gradient-to-r from-transparent via-white/10 to-transparent skew-x-12 animate-shimmer-sweep"
          />
        </div>

        {/* Animated Cyber Core / Orb */}
        <div className="relative flex items-center justify-center shrink-0 w-7 h-7">
          {/* Rotating gradient ring */}
          <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-cyan-500 via-indigo-500 to-purple-500 opacity-75 blur-[1px] animate-spin-slow" />
          {/* Inner core */}
          <div className="relative w-5.5 h-5.5 rounded-full bg-zinc-900 border border-zinc-700 flex items-center justify-center">
            <Zap className="w-3 h-3 text-cyan-400 animate-pulse" />
          </div>
        </div>

        {/* Dynamic Thought Stream & Soundwave */}
        <div className="flex flex-col min-w-[170px] sm:min-w-[210px] space-y-1">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
              <Terminal className="w-3 h-3 text-zinc-500" />
              <span>ביטבוט מעבד</span>
            </div>

            {/* Neural frequency audio bars */}
            <div className="flex items-center gap-0.5 h-3.5">
              <span className="w-0.5 rounded-full bg-cyan-400 animate-bar-1" />
              <span className="w-0.5 rounded-full bg-indigo-400 animate-bar-2" />
              <span className="w-0.5 rounded-full bg-purple-400 animate-bar-3" />
              <span className="w-0.5 rounded-full bg-cyan-300 animate-bar-4" />
            </div>
          </div>

          {/* Sarcastic text with smooth fade transition */}
          <div
            className={`text-[13px] font-medium text-zinc-200 transition-all duration-200 truncate ${
              fade ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'
            }`}
          >
            {SARCASTIC_THOUGHTS[thoughtIndex]}
          </div>
        </div>

        {/* Ambient subtle spark */}
        <Sparkles className="w-3.5 h-3.5 text-zinc-500 shrink-0 opacity-70 animate-pulse hidden sm:block" />
      </div>
    </div>
  );
};
