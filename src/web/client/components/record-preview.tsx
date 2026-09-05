export interface RecordPreviewProps {
  readonly title: string;
  readonly kind: string;
  readonly body: string;
  readonly href: string;
  readonly linkLabel?: string;
  readonly maxCharacters?: number;
}

export const boundedUnicodePreview = (value: string, maximum: number): string => {
  const points = Array.from(value);
  return points.length <= maximum
    ? value
    : `${points.slice(0, maximum).join("").trimEnd()}…`;
};

export const boundedPreview = (body: string, maximum = 420): string => {
  const normalized = body.replace(
    /(?:Retrieve this governed detail separately\.\s*){2,}/g,
    "Retrieve this governed detail separately. ",
  ).trim();
  return boundedUnicodePreview(normalized, maximum);
};

export function RecordPreview({
  title,
  kind,
  body,
  href,
  linkLabel = "Open record",
  maxCharacters,
}: RecordPreviewProps) {
  return (
    <article className="record-preview">
      <div className="record-preview__heading">
        <span className="record-preview__kind">{kind}</span>
        <strong>{title}</strong>
      </div>
      <p>{boundedPreview(body, maxCharacters)}</p>
      <a href={href}>{linkLabel}</a>
    </article>
  );
}
