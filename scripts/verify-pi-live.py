#!/usr/bin/env python3
"""Opt-in live Pi smoke test through wts; private isolated defaults, no raw logs.

One real, tiny request per provider. This consumes provider quota. Never run in
preflight. Uses existing credentials without printing them; removes test copies.
"""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--agent-dir', type=Path, default=Path.home() / '.pi/agent')
    parser.add_argument('--worktree', type=Path, required=True)
    parser.add_argument('--wts', default=str(Path.home() / '.local/bin/wts'))
    parser.add_argument('--pi', default=shutil.which('pi') or 'pi')
    parser.add_argument('--case', action='append', default=[], help='provider=model; defaults to first configured model')
    parser.add_argument('--only', action='append', default=[], help='Limit a follow-up run to these provider IDs')
    parser.add_argument('--thinking', choices=['off', 'low'], default='off')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    native_paths = [args.agent_dir / name for name in ('models.json', 'settings.json', 'auth.json')]
    for native in native_paths:
        if args.report.resolve() == native.resolve() or (args.report.exists() and native.exists() and args.report.samefile(native)):
            parser.error('Report path must not overwrite native configuration')
    original = {name: (args.agent_dir / name).read_bytes() for name in ('models.json', 'settings.json', 'auth.json') if (args.agent_dir / name).exists()}
    config = json.loads(original['models.json'])
    choices = dict(case.split('=', 1) for case in args.case)
    unknown = (set(choices) | set(args.only)) - set(config['providers'])
    if unknown:
        parser.error('Unknown provider IDs: ' + ', '.join(sorted(unknown)))
    if not config['providers']:
        parser.error('No configured providers to test')
    secrets = []

    def collect(value, key=''):
        if isinstance(value, dict):
            for name, child in value.items():
                collect(child, 'secret' if key.lower() == 'headers' else name)
        elif isinstance(value, list):
            for child in value:
                collect(child, key)
        elif isinstance(value, str) and re.search(r'key|token|authorization|secret', key, re.I) and len(value) > 6:
            secrets.append(value)

    for raw in original.values():
        collect(json.loads(raw))
    secrets.extend(value for key, value in os.environ.items() if re.search(r'key|token|secret', key, re.I) and len(value) > 6)

    def redact(text):
        for secret in sorted(secrets, key=len, reverse=True):
            text = text.replace(secret, '[REDACTED]')
        text = re.sub(r'(?i)bearer\s+\S+', 'Bearer [REDACTED]', text)
        text = re.sub(r'\bsk-[A-Za-z0-9_-]+', '[REDACTED]', text)
        return text[:400]

    def run(key, provider):
        model = choices.get(key) or next((m['id'] for m in provider.get('models', []) if m.get('id')), None)
        result = {'provider': key, 'name': provider.get('name') or key, 'model': model, 'requestedThinking': args.thinking}
        if not model:
            return dict(result, status='FAIL', detail='No explicit model configured')
        assert any(m.get('id') == model for m in provider.get('models', [])), f'Unconfigured test model: {key}/{model}'
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix='pi-live-smoke-') as temp:
            root = Path(temp)
            os.chmod(root, 0o700)
            for name in ('models.json', 'auth.json'):
                if name in original:
                    path = root / name
                    path.write_bytes(original[name])
                    path.chmod(0o600)
            settings = {'defaultProvider': key, 'defaultModel': model, 'defaultThinkingLevel': args.thinking, 'quietStartup': True}
            path = root / 'settings.json'
            path.write_text(json.dumps(settings))
            path.chmod(0o600)
            wrapper = root / 'pi-smoke'
            # No credentials in argv. wts launches this shim with its real cwd.
            wrapper.write_text('#!/bin/sh\nexec ' + shlex.quote(args.pi) + ' --offline --no-session --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --no-tools --mode json --system-prompt "Reply briefly. Do not use tools." --thinking ' + args.thinking + ' --print "Reply with exactly PI_SMOKE_OK." "$@"\n')
            wrapper.chmod(0o700)
            env = dict(os.environ, PI_CODING_AGENT_DIR=str(root), PI_BIN=str(wrapper), WTS_HERE='1', PI_TELEMETRY='0')
            try:
                process = subprocess.run([args.wts, 'open', str(args.worktree.resolve()), 'pi'], cwd=args.worktree, env=env, capture_output=True, text=True, timeout=60)
            except subprocess.TimeoutExpired:
                return dict(result, status='TIMEOUT', seconds=round(time.monotonic()-started, 1), detail='No completed reply within 60 seconds')
            messages = []
            for line in process.stdout.splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get('type') == 'message_end' and event.get('message', {}).get('role') == 'assistant':
                    messages.append(event['message'])
            message = messages[-1] if messages else {}
            text = ''.join(block.get('text', '') for block in message.get('content', []) if block.get('type') == 'text')
            matches = message.get('provider') == key and message.get('model') == model
            passed = process.returncode == 0 and matches and 'PI_SMOKE_OK' in text and message.get('stopReason') not in ('error', 'aborted')
            detail = message.get('errorMessage') or (text if messages else process.stderr or process.stdout)
            result.update(status='PASS' if passed else 'FAIL', seconds=round(time.monotonic()-started, 1), selectedProvider=message.get('provider'), selectedModel=message.get('model'), stopReason=message.get('stopReason'), detail=redact(detail.strip()), usage=message.get('usage'))
            return result

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        pending = [pool.submit(run, key, provider) for key, provider in config['providers'].items() if not args.only or key in args.only]
        for future in concurrent.futures.as_completed(pending):
            result = future.result()
            results.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
    unchanged = all((args.agent_dir / name).read_bytes() == raw for name, raw in original.items())
    report = {'command': 'wts open <existing worktree> pi with isolated startup defaults; real Pi, no tools', 'scope': 'One configured chat model per provider; not all catalog models', 'thinking': args.thinking, 'originalFilesUnchanged': unchanged, 'results': sorted(results, key=lambda x: x['provider'])}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print('Original native files unchanged:', unchanged, flush=True)
    return 0 if unchanged and all(r['status'] == 'PASS' for r in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
