import React from 'react';
import { Icons } from '../../components/icons';

export interface CardData {
  title: string;
  description?: string;
  image?: string;
  domain: string;
  siteName?: string;
  favicon?: string;
}

function Img({ src }: { src: string }) {
  const [bad, setBad] = React.useState(false);
  React.useEffect(() => setBad(false), [src]);
  if (bad) return null;
  return <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBad(true)} />;
}

const Frame = ({ name, children }: { name: string; children: React.ReactNode }) => (
  <figure className="sc">
    <figcaption>{name}</figcaption>
    {children}
  </figure>
);

/** Faithful-enough frames; a missing image falls back to each platform's text-only layout. */
export function SocialCards({ data }: { data: CardData }) {
  const { title, description, image, domain, siteName } = data;
  return (
    <div className="sc-list">
      <Frame name="X">
        <div className="sc-x">
          {image && <div className="sc-img r2"><Img src={image} /></div>}
          <div className="sc-pad">
            <div className="sc-muted">{domain}</div>
            <div className="sc-title clamp1">{title}</div>
            {!image && description && <div className="sc-desc clamp2">{description}</div>}
          </div>
        </div>
      </Frame>
      <Frame name="LinkedIn">
        <div className="sc-li">
          {image && <div className="sc-img r191"><Img src={image} /></div>}
          <div className="sc-pad">
            <div className="sc-title clamp2">{title}</div>
            <div className="sc-muted">{domain}</div>
          </div>
        </div>
      </Frame>
      <Frame name="Facebook">
        <div className="sc-fb">
          {image && <div className="sc-img r191"><Img src={image} /></div>}
          <div className="sc-pad">
            <div className="sc-fb-domain">{domain}</div>
            <div className="sc-title clamp2">{title}</div>
            {description && <div className="sc-desc clamp1">{description}</div>}
          </div>
        </div>
      </Frame>
      <Frame name="Slack">
        <div className="sc-slack">
          <div className="sc-slack-bar" />
          <div className="sc-slack-body">
            <div className="sc-slack-site">{data.favicon ? <Img src={data.favicon} /> : <Icons.Globe className="icon" />}{siteName || domain}</div>
            <div className="sc-slack-title clamp2">{title}</div>
            {description && <div className="sc-desc clamp2">{description}</div>}
            {image && <div className="sc-img slack"><Img src={image} /></div>}
          </div>
        </div>
      </Frame>
      <Frame name="iMessage">
        <div className="sc-im">
          {image && <div className="sc-img r191"><Img src={image} /></div>}
          <div className="sc-pad">
            <div className="sc-title clamp2">{title}</div>
            <div className="sc-muted">{domain}</div>
          </div>
        </div>
      </Frame>
    </div>
  );
}
