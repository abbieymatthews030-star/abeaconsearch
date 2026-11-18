import { describe, expect, it } from 'vitest';
import { parseAhmiaHtml } from './search.js';

const FIXTURE = `<ol class="searchResults">
  <li class="result">
    <h4>
      <a href="/search/redirect?search_term=protonmail&redirect_url=http://taxiaii6xr62vugl7qin2fzd4rs6dbqgqcrkxwpoud6uilxwklicapad.onion/proton.html">
        tor.taxi - ProtonMail
      </a>
    </h4>
    <p>All the links for ProtonMail.</p>
    <cite>taxiaii6xr62vugl7qin2fzd4rs6dbqgqcrkxwpoud6uilxwklicapad.onion</cite>
  </li>
  <li class="result">
    <h4><a href="http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/">Ahmia self</a></h4>
  </li>
</ol>`;

describe('parseAhmiaHtml', () => {
  it('unwraps redirect_url query params into onion URLs', () => {
    const hits = parseAhmiaHtml(FIXTURE, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.url).toBe(
      'http://taxiaii6xr62vugl7qin2fzd4rs6dbqgqcrkxwpoud6uilxwklicapad.onion/proton.html',
    );
    expect(hits[0]?.title).toMatch(/ProtonMail/i);
  });
});
