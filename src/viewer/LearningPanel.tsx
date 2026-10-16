import { useEffect, useMemo, useRef, useState } from "react";
import { bindingLabel, effectiveBinding, ViewerConfiguration } from "./model";
import {
  elapsedMs,
  learningKeys,
  LearningSession,
  PracticeKind,
  practiceText,
  recordAttempt,
  resumeSession,
  sessionMetrics,
  startSession,
  stopSession,
} from "./learning";

interface Props {
  config: ViewerConfiguration;
  onHint: (position: number | undefined) => void;
  onClose: () => void;
}

export function LearningPanel({ config, onHint, onClose }: Props) {
  const [layerId, setLayerId] = useState(config.defaultLayer);
  const [kind, setKind] = useState<PracticeKind>("keys");
  const [includeShift, setIncludeShift] = useState(false);
  const [duration, setDuration] = useState(2);
  const [showHint, setShowHint] = useState(true);
  const [session, setSession] = useState<LearningSession>();
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [now, setNow] = useState(performance.now());
  const input = useRef<HTMLInputElement>(null);
  const prompt = useRef<HTMLParagraphElement>(null);
  const currentCharacter = useRef<HTMLElement>(null);
  const sessionRef = useRef(session);
  const keys = useMemo(
    () => learningKeys(config, layerId, includeShift),
    [config, layerId, includeShift],
  );
  const target = text[index];
  const hint = keys.find((key) => key.character === target);
  const active = session !== undefined && session.status !== "finished";
  const metrics = session && sessionMetrics(session, now);
  const update = (next: LearningSession) => {
    sessionRef.current = next;
    setSession(next);
    setNow(performance.now());
  };

  useEffect(() => {
    setLayerId(config.defaultLayer);
    sessionRef.current = undefined;
    setSession(undefined);
    setText("");
    setIndex(0);
    setFeedback("");
  }, [config]);

  useEffect(() => {
    onHint(showHint && active ? hint?.position : undefined);
    return () => onHint(undefined);
  }, [onHint, hint?.position, showHint, active]);

  useEffect(() => {
    if (prompt.current && currentCharacter.current)
      prompt.current.scrollTop = Math.max(
        0,
        currentCharacter.current.offsetTop - prompt.current.clientHeight / 2,
      );
  }, [index, text]);

  useEffect(() => {
    const pause = () => {
      const current = sessionRef.current;
      if (current?.status === "running") {
        const next = stopSession(current, performance.now());
        sessionRef.current = next;
        setSession(next);
        setNow(performance.now());
      }
    };
    const visibility = () => {
      if (document.hidden) pause();
    };
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", visibility);
    const timer = window.setInterval(() => {
      const time = performance.now();
      setNow(time);
      const current = sessionRef.current;
      if (
        current?.status === "running" &&
        elapsedMs(current, time) >= current.durationMs
      ) {
        const next = stopSession(current, time, true);
        sessionRef.current = next;
        setSession(next);
      }
    }, 200);
    return () => {
      clearInterval(timer);
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  const begin = () => {
    setText(practiceText(keys, kind));
    setIndex(0);
    setFeedback("");
    update(startSession(duration * 60000, performance.now()));
    input.current?.focus();
  };
  const label = (character: string) =>
    character === " " ? "Space" : character;

  return (
    <section className="viewer-learning" aria-label="Learning mode">
      <div className="viewer-panel-heading">
        <h2>Learning mode</h2>
        <button onClick={onClose}>Close learning</button>
      </div>
      <p>
        Practice your loaded keymap. Tap hold-tap keys for their characters;
        activate the selected layer on your keyboard. Text assumes a US host
        layout. Macros, combos and non-text actions are not drills.
      </p>
      <div className="learning-options">
        <label>
          Practice
          <select
            value={kind}
            disabled={active}
            onChange={(event) =>
              setKind(event.target.value === "words" ? "words" : "keys")
            }
          >
            <option value="keys">Guided key drills</option>
            <option value="words">Typing practice</option>
          </select>
        </label>
        <label>
          Practice layer
          <select
            value={layerId}
            disabled={active}
            onChange={(event) => setLayerId(Number(event.target.value))}
          >
            {config.layers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.name || `Layer ${layer.id}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Session length
          <select
            value={duration}
            disabled={active}
            onChange={(event) => setDuration(Number(event.target.value))}
          >
            <option value={1}>1 minute</option>
            <option value={2}>2 minutes</option>
            <option value={5}>5 minutes</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={includeShift}
            disabled={active}
            onChange={(event) => setIncludeShift(event.target.checked)}
          />
          Include Shift characters
        </label>
        <label>
          <input
            type="checkbox"
            checked={showHint}
            onChange={(event) => setShowHint(event.target.checked)}
          />
          Key hints
        </label>
      </div>
      {!keys.some((key) => key.character !== " ") && (
        <p role="status">
          This layer has no supported printable keys. Select another layer.
        </p>
      )}
      {kind === "words" && (
        <p>
          Words use only mapped letters and Space; symbol-only or limited
          layouts fall back to character groups.
        </p>
      )}
      <dl className="learning-stats" aria-label="Session statistics">
        <div>
          <dt>Session WPM</dt>
          <dd>{metrics?.average.toFixed(1) ?? "0.0"}</dd>
        </div>
        <div>
          <dt>Last 1 minute WPM</dt>
          <dd>{metrics?.minute.toFixed(1) ?? "0.0"}</dd>
        </div>
        <div>
          <dt>Last 2 minutes WPM</dt>
          <dd>{metrics?.twoMinutes.toFixed(1) ?? "0.0"}</dd>
        </div>
        <div>
          <dt>Accuracy</dt>
          <dd>{metrics?.accuracy.toFixed(1) ?? "100.0"}%</dd>
        </div>
        <div>
          <dt>Active time</dt>
          <dd>{Math.floor((metrics?.elapsed ?? 0) / 1000)}s</dd>
        </div>
        <div>
          <dt>Correct / mistakes</dt>
          <dd>
            {metrics?.correct ?? 0} / {metrics?.mistakes ?? 0}
          </dd>
        </div>
      </dl>
      <div className="learning-actions">
        <button
          disabled={active || !keys.some((key) => key.character !== " ")}
          onClick={begin}
        >
          {session ? "New session" : "Start session"}
        </button>
        {active && (
          <>
            <button
              onClick={() => {
                if (session.status === "running") {
                  update(stopSession(session, performance.now()));
                } else {
                  update(resumeSession(session, performance.now()));
                  input.current?.focus();
                }
              }}
            >
              {session.status === "running" ? "Pause" : "Resume"}
            </button>
            <button
              onClick={() =>
                update(stopSession(session, performance.now(), true))
              }
            >
              Finish session
            </button>
          </>
        )}
        <span role="status">
          {!session
            ? "Ready to learn"
            : session.status === "finished"
              ? "Session complete"
              : session.status === "paused"
                ? "Paused - resume when ready"
                : "Session in progress"}
        </span>
      </div>
      {text && (
        <p
          ref={prompt}
          className="learning-prompt"
          aria-label="Practice passage"
        >
          <span className="learning-completed">{text.slice(0, index)}</span>
          <mark ref={currentCharacter}>
            {target === " " ? "\u2423" : target}
          </mark>
          {text.slice(index + 1)}
        </p>
      )}
      {showHint && hint && active && (
        <p className="learning-hint">
          Next: <strong>{label(target)}</strong>
          {hint.shifted ? " with Shift" : ""} -{" "}
          {config.layers.find((layer) => layer.id === layerId)?.name}, key{" "}
          {hint.position + 1} (
          {
            bindingLabel(
              config,
              effectiveBinding(config, hint.position, [
                ...new Set([layerId, config.defaultLayer]),
              ]),
            ).tap
          }
          ). The outlined key shows its physical position.
        </p>
      )}
      <input
        ref={input}
        className="learning-input"
        aria-label="Practice typing"
        aria-describedby="learning-input-help"
        readOnly
        value=""
        autoComplete="off"
        spellCheck={false}
        placeholder="Type the highlighted character here"
        onPaste={(event) => event.preventDefault()}
        onDrop={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (
            event.key.length !== 1 ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            event.nativeEvent.isComposing
          )
            return;
          event.preventDefault();
          const current = sessionRef.current;
          if (current?.status !== "running" || event.repeat) return;
          const correct = event.key === target;
          const next = recordAttempt(current, correct, performance.now());
          update(next);
          if (next.status !== "running") return;
          setFeedback(correct ? "" : `Try again: ${label(target)}`);
          if (correct) {
            if (index + 1 === text.length) {
              setText(practiceText(keys, kind));
              setIndex(0);
            } else {
              setIndex(index + 1);
            }
          }
        }}
      />
      <p className="learning-feedback" aria-live="polite">
        {feedback}
      </p>
      <p id="learning-input-help">
        Type one character at a time; mistakes do not advance the passage. Paste
        and held-key repeat do not count. Switching away pauses the session;
        click Resume to continue. WPM = correct characters / 5 per active
        minute. Rolling windows use elapsed active time until full. Pauses are
        excluded. Results stay here until a new session, keymap reload,
        disconnect, or leaving learning mode; no typed text is saved.
      </p>
    </section>
  );
}
