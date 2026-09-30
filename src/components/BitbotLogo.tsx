import React from 'react';

interface BitbotLogoProps {
  size?: 'sm' | 'md' | 'lg';
  showSubtitle?: boolean;
}

export const BitbotLogo: React.FC<BitbotLogoProps> = ({ size = 'md', showSubtitle = true }) => {
  const badgeSize = {
    sm: 'w-8 h-8 text-sm rounded-xl',
    md: 'w-10 h-10 text-base rounded-2xl',
    lg: 'w-14 h-14 text-2xl rounded-2xl',
  }[size];

  return (
    <div id="bitbot-logo-container" className="flex items-center gap-3 select-none">
      {/* Black logo box with white B! */}
      <div
        id="bitbot-brand-logo"
        className={`${badgeSize} bg-black text-white font-black flex items-center justify-center tracking-tighter shadow-sm transition-transform duration-200 hover:scale-105 shrink-0`}
        title="Bitbot"
      >
        <div dir="ltr" className="flex items-baseline font-mono tracking-tight font-extrabold text-white">
          <span>B</span>
          <span className="text-zinc-300">!</span>
        </div>
      </div>

      <div className="flex flex-col text-right">
        <span className="font-extrabold text-xl tracking-tight text-black leading-none font-['Rubik',sans-serif]">
          Bitbot
        </span>
        {showSubtitle && (
          <span className="text-[12px] text-zinc-400 font-medium tracking-wide mt-1">
            האמת ישר בפרצוף
          </span>
        )}
      </div>
    </div>
  );
};
