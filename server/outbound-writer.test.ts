import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { polishDraftWithCodex, writeDraft } from './outbound-writer'

const event = { title: 'Advancing Data Center Construction East', shortTitle: 'ADC East' }
const person = { name: 'Robin Example', title: 'Electrical Testing Manager', company: 'Example Power', attendance: 'speaker', bucket: 'direct' }

test('drafts use sourced facts and a meeting ask that reflects attendance', () => {
  const hook = 'you spoke about substation apprenticeship programs'
  const sourced = writeDraft(event, { ...person, hook, hookSource: 'https://example.com/talk' })
  assert.equal(sourced.subject, 'UT student working on data center training, 20 minutes at ADC East?')
  assert.match(sourced.body, /Hey Robin,[\s\S]+substation apprenticeship programs/)
  assert.match(sourced.body, /before or after your session/)
  assert.doesNotMatch(sourced.body, /https?:\/\//)

  const unconfirmed = writeDraft(event, { ...person, bucket: 'connector', attendance: 'unconfirmed', hook })
  assert.doesNotMatch(unconfirmed.body, /substation apprenticeship programs/)
  assert.match(unconfirmed.body, /commissioning or technician training lead you think I should talk to/)
  assert.match(unconfirmed.body, /If you’re planning to be at ADC East/)
  assert.throws(() => writeDraft(event, { ...person, bucket: 'irrelevant' }))
})

test('Codex receives only the opening and replaces only that paragraph', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'conference-writer-test-'))
  const saved = process.env.CODEX_BIN
  const savedKey = process.env.APOLLO_API_KEY
  const binary = join(folder, 'mock-codex')
  try {
    await writeFile(binary, `#!/bin/sh
set -eu
if /usr/bin/printenv APOLLO_API_KEY >/dev/null; then exit 4; fi
test "$1" = exec
result=''
previous=''
for arg in "$@"; do
  if test "$previous" = --output-last-message; then result="$arg"; fi
  previous="$arg"
done
prompt="$(/bin/cat)"
case "$prompt" in *'Example Power'*) ;; *) exit 2 ;; esac
case "$prompt" in *'Hey Robin'*) exit 3 ;; esac
printf '%s' '{"opening":"I’d like to hear how you evaluate a new electrical testing technician."}' > "$result"
`, { mode: 0o700 })
    process.env.CODEX_BIN = binary
    process.env.APOLLO_API_KEY = 'must-stay-in-parent'
    const original = writeDraft(event, person)
    const polished = await polishDraftWithCodex(original)
    const paragraphs = original.body.split('\n\n')
    paragraphs[2] = 'I’d like to hear how you evaluate a new electrical testing technician.'
    assert.deepEqual(polished, { subject: original.subject, body: paragraphs.join('\n\n') })
  } finally {
    if (saved === undefined) delete process.env.CODEX_BIN
    else process.env.CODEX_BIN = saved
    if (savedKey === undefined) delete process.env.APOLLO_API_KEY
    else process.env.APOLLO_API_KEY = savedKey
    await rm(folder, { recursive: true, force: true })
  }
})
