import React from 'react';
import QRCode from 'qrcode';
import { Icons } from '../../components/icons';
import { Tip } from '../../components/tip';

function download(href: string, filename: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Canvas QR of `${shortUrl}?qr=1`, 240px, with PNG and SVG downloads. */
export function QrPanel({ shortUrl, name }: { shortUrl: string; name: string }) {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const target = `${shortUrl}?qr=1`;
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!canvas.current) return;
    setFailed(false);
    QRCode.toCanvas(canvas.current, target, { width: 240, margin: 2 }).catch(() => setFailed(true));
  }, [target]);

  const png = () => {
    if (canvas.current) download(canvas.current.toDataURL('image/png'), `${name}.png`);
  };
  const svg = async () => {
    const text = await QRCode.toString(target, { type: 'svg', margin: 2 });
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    download(url, `${name}.svg`);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="qr-panel">
      <canvas ref={canvas} width={240} height={240} className="qr-canvas" role="img" aria-label={`QR code for ${target}`} hidden={failed} />
      <code className="qr-url">{target}</code>
      <div className="hstack">
        <button type="button" className="btn btn-sm" onClick={png}><Icons.Download /> PNG</button>
        <button type="button" className="btn btn-sm" onClick={svg}><Icons.Download /> SVG</button>
        <Tip label="Scans are counted separately from clicks."><span className="info-dot" tabIndex={0} role="img" aria-label="Scans are counted separately from clicks."><Icons.Info /></span></Tip>
      </div>
    </div>
  );
}
