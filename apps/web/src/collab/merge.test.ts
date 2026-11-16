import { describe, expect, it } from 'vitest';
import { applyMerge, planMerge } from './merge';

const doc = (summary: string, goals: string, extra = '') => `## Summary\n${summary}\n\n## Goals\n${goals}${extra}`;
const base = { title: 'Export', document: doc('base', 'g1') };

describe('planMerge / applyMerge', () => {
  it('combines changes to different sections automatically', () => {
    const plan = planMerge(base, { title: 'Export', document: doc('mine', 'g1') }, { title: 'Export', document: doc('base', 'theirs') });
    expect(plan.needsChoice).toBe(false);
    expect(applyMerge(plan).document).toBe(doc('mine', 'theirs'));
  });

  it('flags sections changed differently on both sides and applies mine / theirs / both', () => {
    const plan = planMerge(base, { title: 'Export', document: doc('mine', 'g1') }, { title: 'Export', document: doc('theirs', 'g2') });
    expect(plan.sections.filter((section) => section.conflict).map((section) => section.heading)).toEqual(['Summary']);
    expect(applyMerge(plan, { summary: 'mine' }).document).toBe(doc('mine', 'g2'));
    expect(applyMerge(plan, { summary: 'theirs' }).document).toBe(doc('theirs', 'g2'));
    expect(applyMerge(plan, { summary: 'both' }).document).toBe(doc('mine\n\ntheirs', 'g2'));
  });

  it('does not conflict when both sides made the same change, and handles added and removed sections', () => {
    const mine = { title: 'Export', document: `${doc('same', 'g1')}\n\n## Mine only\nx` };
    const theirs = { title: 'Export', document: doc('same', 'g1') };
    expect(planMerge(base, mine, theirs).needsChoice).toBe(false);
    expect(applyMerge(planMerge(base, mine, { title: 'Export', document: '## Summary\nbase' })).document).toBe('## Summary\nsame\n\n## Mine only\nx');
  });

  it('keeps a section removed by one side when the other did not touch it, and conflicts when the other edited it', () => {
    const removed = { title: 'Export', document: '## Summary\nbase' };
    expect(applyMerge(planMerge(base, removed, base)).document).toBe('## Summary\nbase');
    const plan = planMerge(base, removed, { title: 'Export', document: doc('base', 'edited') });
    expect(plan.sections.find((section) => section.key === 'goals')?.conflict).toBe(true);
    expect(applyMerge(plan, { goals: 'theirs' }).document).toBe(doc('base', 'edited'));
    expect(applyMerge(plan, { goals: 'mine' }).document).toBe('## Summary\nbase');
  });

  it('merges the text before the first heading and the title', () => {
    const b = { title: 'A', document: 'intro\n\n## S\nx' };
    expect(applyMerge(planMerge(b, { title: 'A', document: 'my intro\n\n## S\nx' }, { title: 'B', document: 'intro\n\n## S\ny' })).document).toBe('my intro\n\n## S\ny');
    const conflict = planMerge(b, { title: 'Mine', document: b.document }, { title: 'Theirs', document: b.document });
    expect(conflict.title.conflict).toBe(true);
    expect(applyMerge(conflict).title).toBe('Mine');
    expect(applyMerge(conflict, {}, 'theirs').title).toBe('Theirs');
    expect(planMerge(b, { title: 'Mine', document: b.document }, { title: 'A', document: b.document }).title.auto).toBe('Mine');
  });
});
