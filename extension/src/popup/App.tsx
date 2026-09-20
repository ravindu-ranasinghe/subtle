import { useCallback, useEffect, useState } from 'react';
import {
  isBackend,
  isError,
  isLanguagePackRequired,
  isModelProgress,
  type Config,
  type WhisperSize,
} from '@subtle/shared';
import { downloadLanguagePack } from '../offscreen/translate/chrome-translator.js';
import { EXPORTS, type ExportFormat } from '../content/saved.js';
import {
  LANGUAGES,
  MODEL_SIZES,
  capturingTabId,
  currentTabId,
  deleteModels,
  downloadText,
  listWords,
  loadConfig,
  removeWord,
  saveConfig,
  send,
  stopCapture,
  toggleCapture,
  type SavedWord,
} from './chrome.js';

interface Progress {
  loaded: number;
  total: number;
  model: string;
}

/** Set when Worker C reports a pair Chrome will only fetch after a click. */
interface PackRequest {
  src: string;
  tgt: string;
}

export function App(): React.ReactElement {
  const [config, setConfig] = useState<Config | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pack, setPack] = useState<PackRequest | null>(null);
  const [packProgress, setPackProgress] = useState<number | null>(null);
  const [words, setWords] = useState<SavedWord[]>([]);
  const [engines, setEngines] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [dubStatus, setDubStatus] = useState('');

  useEffect(() => {
    void (async () => {
      setConfig(await loadConfig());
      const id = await currentTabId();
      setTabId(id);
      setCapturing(id !== null && (await capturingTabId()) === id);
      setWords(await listWords());
      const stored = await chrome.storage.local.get('ui');
      setDebug(Boolean((stored['ui'] as { debug?: boolean } | undefined)?.debug));
      const voice = await chrome.runtime.sendMessage({ type: 'getDubStatus' }).catch(() => null) as { text?: string } | null;
      setDubStatus(voice?.text ?? '');
    })();
  }, []);

  useEffect(() => {
    const listener = (message: unknown): void => {
      const voice = message as { type?: string; text?: string } | null;
      if (voice?.type === 'dubStatus' && typeof voice.text === 'string') setDubStatus(voice.text);
      if (isModelProgress(message)) {
        setProgress({ loaded: message.loaded, total: message.total, model: String(message.model) });
        if (message.loaded >= message.total) setProgress(null);
        return;
      }
      if (isLanguagePackRequired(message)) {
        setPack({ src: message.src, tgt: message.tgt });
        return;
      }
      if (isBackend(message)) {
        setEngines(
          [message.adapter ?? message.backend, message.translator].filter(Boolean).join(' · '),
        );
        return;
      }
      if (isError(message)) setError(message.message);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const update = useCallback(
    (patch: Partial<Config>) => {
      setConfig((current) => {
        if (!current) return current;
        const next = { ...current, ...patch };
        void saveConfig(next);
        return next;
      });
    },
    [],
  );

  if (!config) return <main>Loading…</main>;

  const onToggleCapture = async (): Promise<void> => {
    if (tabId === null) return;
    setError(null);
    setBusy(true);
    try {
      if (capturing) await stopCapture(tabId);
      else await toggleCapture(tabId);
      setCapturing((await capturingTabId()) === tabId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDownloadPack = async (): Promise<void> => {
    if (!pack) return;
    try {
      // Must run inside this click: Chrome requires transient activation.
      await downloadLanguagePack(pack.src, pack.tgt, (loaded, total) =>
        setPackProgress(total > 0 ? loaded / total : 0),
      );
      await send({ type: 'languagePackReady' });
      setPack(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPackProgress(null);
    }
  };

  const exportWords = (format: ExportFormat): void => {
    const { filename, mime, render } = EXPORTS[format];
    downloadText(filename, mime, render(words));
  };

  return (
    <main>
      <h1>
        <span className={capturing ? 'dot on' : 'dot'} />
        Subtle
      </h1>

      {(error || pack) && (
        <div className="error" role="status">
          {error}
          {pack && (
            <div>
              <button onClick={() => void onDownloadPack()} disabled={packProgress !== null}>
                {packProgress === null
                  ? `Download ${pack.src} → ${pack.tgt} language pack`
                  : `Downloading… ${Math.round(packProgress * 100)}%`}
              </button>
            </div>
          )}
        </div>
      )}

      <button className="primary wide" onClick={() => void onToggleCapture()} disabled={tabId === null || busy}>
        {busy ? 'Please wait…' : capturing ? 'Stop captions' : 'Start captions on this tab'}
      </button>

      <section>
        <h2>Languages</h2>
        <div className="row">
          <label>
            <span>Spoken</span>
            <select value={config.srcLang} onChange={(e) => update({ srcLang: e.target.value })}>
              <option value="auto">Detect</option>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Translate to</span>
            <select value={config.tgtLang} onChange={(e) => update({ tgtLang: e.target.value })}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section>
        <h2>Dubbing</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={config.dubbing}
            onChange={(e) => update({ dubbing: e.target.checked })}
          />
          Dub audio in {LANGUAGES.find((l) => l.code === config.tgtLang)?.label ?? config.tgtLang}
        </label>
        <p className="hint">Natural AI speech with the original audio lowered underneath. Works with the translation line hidden.</p>
        {config.dubbing && <p className="hint" role="status">{config.tgtLang === 'zh' ? 'Chinese uses your best installed system voice.' : dubStatus || 'Supertonic 3 runs on your device. First use downloads about 400 MB.'}</p>}
        {config.dubbing && <p className="hint">AI-generated voice. Neural voice use is subject to the <a href="licenses/supertonic-model.txt" target="_blank" rel="noreferrer">model license and use restrictions</a>.</p>}
      </section>

      <section>
        <h2>Recognition model</h2>
        <p className="hint">Fast previews use Tiny. This choice controls the accuracy of finished captions and dubbing.</p>
        <div className="models">
          {(Object.keys(MODEL_SIZES) as WhisperSize[]).map((size) => (
            <label key={size}>
              <input
                type="radio"
                name="model"
                checked={config.whisperModel === size}
                onChange={() => update({ whisperModel: size })}
              />
              <span>{size}</span>
              <span className="size">{MODEL_SIZES[size]} MB</span>
            </label>
          ))}
        </div>
        {progress && (
          <>
            <progress value={progress.loaded} max={progress.total || 1} />
            <p className="hint">
              Downloading {progress.model} — {Math.round((progress.loaded / (progress.total || 1)) * 100)}%
            </p>
          </>
        )}
        <button
          className="wide"
          onClick={() => {
            void deleteModels();
            setProgress(null);
          }}
        >
          Delete downloaded models
        </button>
        <p className="hint">Frees disk space. The next start re-downloads.</p>
      </section>

      <section>
        <h2>Captions</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={config.showTranslation}
            onChange={(e) => update({ showTranslation: e.target.checked })}
          />
          Show translation line
        </label>
        <label>
          <span>Font size — {config.fontSize}px</span>
          <input
            type="range"
            min={14}
            max={48}
            step={1}
            value={config.fontSize}
            onChange={(e) => update({ fontSize: Number(e.target.value) })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={debug}
            onChange={(e) => {
              setDebug(e.target.checked);
              void chrome.storage.local
                .get('ui')
                .then((s) => chrome.storage.local.set({ ui: { ...(s['ui'] ?? {}), debug: e.target.checked } }));
            }}
          />
          Debug panel
        </label>
        <p className="hint">Alt+Shift+C captions · T translation · I immersion · R replay · D debug</p>
        {engines && <p className="hint">Running on {engines}</p>}
      </section>

      <section>
        <h2>Saved words ({words.length})</h2>
        {words.length === 0 ? (
          <p className="empty">Click a word in the captions to look it up and save it.</p>
        ) : (
          <ul className="words">
            {[...words].reverse().map((w) => (
              <li key={`${w.word}-${w.savedAt}`}>
                <span className="w">{w.word}</span>
                <span className="t">{w.translation}</span>
                <button
                  className="x"
                  title="Remove"
                  onClick={() => void removeWord(w.word, w.savedAt).then(setWords)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="row">
          <button disabled={words.length === 0} onClick={() => exportWords('csv')}>
            Export CSV
          </button>
          <button disabled={words.length === 0} onClick={() => exportWords('anki')}>
            Export Anki
          </button>
        </div>
      </section>
    </main>
  );
}
