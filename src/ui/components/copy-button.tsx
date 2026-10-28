import React from 'react';
import { Icons } from './icons';
import { IconButton } from './tip';
import { copyText } from '../lib/clipboard';

/** Copy icon-button: flips to a check for 1.2s and announces "Copied". */
export function CopyButton({ text, label = 'Copy', small = true }: { text: string; label?: string; small?: boolean }) {
  const [done, setDone] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  const onClick = async () => {
    if (!(await copyText(text))) return;
    setDone(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1200);
  };
  return (
    <span className="copy-wrap">
      <IconButton
        icon={done ? <Icons.Check /> : <Icons.Copy />}
        label={label}
        small={small}
        onClick={onClick}
        className={done ? 'copied' : undefined}
      />
      <span className="sr-only" aria-live="polite">{done ? 'Copied' : ''}</span>
    </span>
  );
}
