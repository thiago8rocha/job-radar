import { describe, expect, it } from 'vitest';
import { detectWorkModel, resolveWorkModel } from '../src/pipeline/work-model.js';
import { job } from './helpers.js';

const model = (overrides: Parameters<typeof job>[0]) => detectWorkModel(job(overrides));

describe('work model', () => {
  it('trusts the source when the text has no contradicting signal', () => {
    expect(model({ workModel: 'remote', description: 'We build great software together.' })).toBe('remote');
    expect(model({ workModel: 'hybrid' })).toBe('hybrid');
  });

  it('lets the title or location override a "remote" source', () => {
    expect(model({ workModel: 'remote', title: 'Senior QA Engineer (Hybrid)' })).toBe('hybrid');
    expect(model({ workModel: 'remote', title: 'Analista de Testes Sênior - Híbrido (SP)' })).toBe('hybrid');
    expect(model({ workModel: 'remote', locations: ['São Paulo - Presencial'] })).toBe('onsite');
  });

  it('lets explicit phrases in the description override a "remote" source', () => {
    expect(model({ workModel: 'remote', description: 'This is a hybrid role based in Lisbon.' })).toBe('hybrid');
    expect(model({ workModel: 'remote', description: 'Modelo híbrido, 3 dias por semana no escritório.' })).toBe('hybrid');
    expect(model({ workModel: 'remote', description: 'Atuação em regime híbrido na Faria Lima.' })).toBe('hybrid');
    expect(model({ workModel: 'remote', description: 'Vaga 100% presencial em Curitiba.' })).toBe('onsite');
    expect(model({ workModel: 'remote', description: 'Fully on-site position in Austin.' })).toBe('onsite');
    expect(model({ workModel: 'remote', description: 'Come in 2 days a week at the office.' })).toBe('hybrid');
  });

  it('keeps the more demanding model when the source and the text disagree', () => {
    expect(model({ workModel: 'hybrid', description: 'Vaga 100% presencial.' })).toBe('onsite');
    expect(model({ workModel: 'onsite', description: 'Remote friendly.' })).toBe('onsite');
  });

  it('ignores hybrid mentions that offer a choice or describe something else', () => {
    expect(model({ workModel: 'remote', description: 'Benefícios: flexibilidade de trabalho híbrido ou remoto.' })).toBe('remote');
    expect(model({ workModel: 'remote', description: 'You can work remote or in a hybrid setup.' })).toBe('remote');
    expect(model({ workModel: 'remote', description: 'Buscamos um profissional híbrido que atue em testes e requisitos.' })).toBe('remote');
    expect(model({ workModel: 'remote', description: 'Offices in New Jersey and Boston; we are remote-first.' })).toBe('remote');
  });

  it('infers remote for an unlabeled job only when nothing points the other way', () => {
    expect(resolveWorkModel(job({ workModel: undefined, locations: ['Brazil'], description: 'This role is remote.' }))).toEqual({ model: 'remote', source: 'inferred' });
    expect(model({ workModel: undefined, locations: ['Brazil'], description: 'This is a hybrid role in our Sao Paulo office.' })).toBe('hybrid');
    expect(model({ workModel: undefined, locations: ['Brazil'], description: 'Based in our office.' })).toBeUndefined();
  });
});
