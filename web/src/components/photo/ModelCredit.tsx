/**
 * Attribution of the detection model, wherever its detections are drawn (photo panel, upload
 * thumbnail): "Roboflow" and, for the facade model, the creator, the title and the licence that
 * CC BY 4.0 requires. Renders nothing for manual annotation.
 */
export const creditLink = 'rounded-xs underline decoration-ink-500 underline-offset-2 hover:text-paper hover:decoration-ink-300 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

export default function ModelCredit({ model }: { model: { provider: string; modelId: string; universeUrl?: string } }) {
  if (model.provider === 'manual') return null;
  const isFacadeModel = model.modelId.startsWith('building-facade-segmentation-instance');
  const version = model.modelId.split('/')[1];
  return (
    <>
      Detections:{' '}
      <a className={creditLink} href="https://roboflow.com" target="_blank" rel="noreferrer">
        Roboflow
      </a>{' '}
      ·{' '}
      {isFacadeModel ? (
        <>
          <a className={creditLink} href={model.universeUrl ?? 'https://universe.roboflow.com/building-facade/building-facade-segmentation-instance'} target="_blank" rel="noreferrer">
            building-facade-segmentation-instance{version ? ` v${version}` : ''}
          </a>{' '}
          by Building Facade,{' '}
          <a className={creditLink} href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
            CC BY 4.0
          </a>
        </>
      ) : model.universeUrl ? (
        <a className={creditLink} href={model.universeUrl} target="_blank" rel="noreferrer">
          {model.modelId}
        </a>
      ) : (
        <span className="num">{model.modelId}</span>
      )}
    </>
  );
}
