import { describe, expect, it } from 'vitest';
import {
  deniedAnswerText,
  evaluateQueryContent,
  looksLikeModelRefusal,
} from './content-policy.js';

describe('evaluateQueryContent', () => {
  it('allows ordinary and morally grey topics', () => {
    const allowed = [
      'how does encryption work',
      'arguments for and against capital punishment',
      'history of psychedelic research',
      'how are guns legally sold in the US',
      'ethical debate on abortion',
      'how does tor anonymity work',
      'women in sports records',
      'animal husbandry best practices',
    ];
    for (const q of allowed) {
      expect(evaluateQueryContent(q), q).toEqual({ allowed: true });
    }
  });

  it('denies bestiality queries', () => {
    const denied = evaluateQueryContent('bestiality videos');
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.category).toBe('bestiality');

    const zoophilia = evaluateQueryContent('zoophilia forums');
    expect(zoophilia.allowed).toBe(false);
  });

  it('denies sexual violence against women', () => {
    const denied = evaluateQueryContent('how to rape a woman');
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.category).toBe('sexual_violence_against_women');
  });

  it('denies physical violence against women', () => {
    const phrase = evaluateQueryContent('violence against women tactics');
    expect(phrase.allowed).toBe(false);
    if (!phrase.allowed) expect(phrase.category).toBe('physical_violence_against_women');

    const howTo = evaluateQueryContent('how to beat your wife');
    expect(howTo.allowed).toBe(false);
  });

  it('returns denial copy for each category', () => {
    expect(deniedAnswerText('bestiality')).toMatch(/bestiality/i);
    expect(deniedAnswerText('sexual_violence_against_women')).toMatch(/violence against women/i);
    expect(deniedAnswerText('physical_violence_against_women')).toMatch(/violence against women/i);
  });
});

describe('looksLikeModelRefusal', () => {
  it('detects common soft refusals', () => {
    expect(looksLikeModelRefusal("I'm sorry, but I can't help with that.")).toBe(true);
    expect(looksLikeModelRefusal('As an AI I must refuse this request.')).toBe(true);
    expect(looksLikeModelRefusal('Penguins live in the Southern Hemisphere.')).toBe(false);
  });
});
