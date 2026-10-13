// Lógica pura: sem DOM, sem rede, sem relógio escondido. Importada pelo navegador e pelo node --test.
export const TETO = 10; // anfitrião + 9. Único lugar com o número: mensagem de sala cheia, contador e testes derivam daqui.
export const PENDENTES = 20; // conexões ainda sem código + na sala de espera
export const ERROS_MAX = 10; // códigos errados até a sala trancar
export const PRESENCA_MS = 60000; // ciclo da sondagem de presença (a cada minuto)
export const SONDA_MS = 12000; // quanto a sonda espera a resposta `presenca` antes de dar a sala por fechada
export const ENTRAR_MS = 10000; // quem conecta e não manda nada em ENTRAR_MS é derrubado (também o prazo do `entrar` depois de `pedeCodigo`)
const NOME_MAX = 24;
export const PRESETS = {
  leve: { w: 1280, h: 720, fps: 30, mbps: 2.5, hint: 'motion' },
  detalhe: { w: 1920, h: 1080, fps: 30, mbps: 8, hint: 'detail' },
  movimento: { w: 1920, h: 1080, fps: 60, mbps: 10, hint: 'motion' },
};
export const MSG = {
  semPermissao: 'Você não está autorizado a abrir salas. Mande este ID ao admin:',
  expirou: data => `Seu certificado de anfitrião expirou em ${data}. Foi criado um novo. Envie ao admin este ID novo para ele atualizar a lista:`,
  expirouNota: 'Enquanto isso você não consegue abrir salas.',
  naoAutorizado: 'Esta sala não é de um anfitrião autorizado. Seu nome e código não foram enviados.',
  foraDoAr: 'Não consegui confirmar o anfitrião agora. Nada foi enviado.',
  recusado: 'O anfitrião recusou sua entrada.',
  cheia: `A sala está cheia (${TETO} pessoas).`,
  aguardeVaga: 'Sala cheia. Aguarde uma vaga.',
  errado: 'Código incorreto. Confira com quem abriu a sala.',
  trancada: 'Essa sala não aceita mais ninguém (muitas tentativas erradas). Peça ao anfitrião para reabrir a sala.',
  impostor: 'Essa conexão não veio de quem criou o link. Seu nome e código não foram enviados.',
  fim: 'A sala foi encerrada.',
  erroRede: tipo => `Erro de conexão: ${tipo}`,
  salaFechada: 'A sala não está aberta.',
  caiu: 'A conexão com o anfitrião caiu.',
  linkIncompleto: 'Link incompleto. Peça o link de novo para quem abriu a sala.',
  entrou: nome => `${nome} entrou`,
  conferindo: 'Conferindo sua participação…',
  aguardando: 'Aguardando o anfitrião aceitar',
  pedeCodigo: 'Não consegui confirmar sua participação. Digite o código da sala.',
  linkFixo: 'Seu link é sempre este.',
  linkOcupado: 'Seu link fixo está ocupado (outra aba ou queda recente; costuma liberar em ~2 min). Use este link por enquanto.',
  linkTomado: 'Seu link fixo foi tomado por outra aba enquanto a conexão caiu. Quem já está na sala continua; para receber gente nova, feche a outra aba e reabra a sala.',
  aparelhoInvalido: 'Nome do aparelho inválido: use de 1 a 24 caracteres, sem símbolos invisíveis.',
  certRenovado: 'Seu certificado de aparelho venceu e foi renovado. Use "Pedir acesso" para mandar o ID novo ao admin.',
  linkInvalido: 'Esse link não é de uma sala do RYVO. Cole o link inteiro que você recebeu.',
  copiaFalhou: 'Não foi possível copiar',
};
// Título da tela de erro, por tipo (S04 R11). `padrao` vale para quem não passa título.
export const TITULO = {
  padrao: 'Algo deu errado', semPermissao: 'Sem permissão', expirou: 'Certificado vencido', semConexao: 'Sem conexão',
  naoAutorizado: 'Sala não autorizada', foraDoAr: 'Sem confirmação', salaFechada: 'Sala fechada', impostor: 'Conexão recusada',
  fim: 'Sala encerrada', caiu: 'Conexão perdida', recusado: 'Entrada recusada', trancada: 'Sala trancada', cheia: 'Sala cheia',
  linkIncompleto: 'Link incompleto',
};

// Identidade: cada ponta usa UM certificado DTLS; a impressão digital (sha-256, 64 hex) é o ID.
// Estrito de propósito (herdado do SharedScreen v1): só vale se TODA linha a=fingerprint for sha-256
// com o mesmo valor; qualquer linha extra, isca ou algoritmo diferente devolve null.
export const fpUnico = sdp => {
  const vals = sdp.split(/\r?\n/).filter(l => /^a=fingerprint:/i.test(l))
    .map(l => /^a=fingerprint:sha-256 ([0-9a-f]{2}(?::[0-9a-f]{2}){31})\s*$/i.exec(l)?.[1].replace(/:/g, '').toLowerCase());
  return vals.length > 0 && vals.every(x => x && x === vals[0]) ? vals[0] : null;
};
export const confere = (sdp, esperado) => !!esperado && fpUnico(sdp) === esperado;
export const novoPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0');

// Cor do avatar: índice 1..9 (tokens --avatar-1..9 de paleta.css) a partir do nome. Mesmo nome, mesma cor, em qualquer aba.
export const corAvatar = nome => { let h = 0; for (const c of nome) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 9 + 1; };

// Sem controle (Cc) nem invisível/bidi (Cf: U+202E, U+200B…), exceto U+200D (ZWJ), que emoji composto precisa (D15, H12).
const CTRL = /(?!‍)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]/u;
export const limpaNome = n => n.replace(new RegExp(CTRL.source, 'gu'), '');
const nomeValido = n => typeof n === 'string' && n.length >= 1 && n.length <= NOME_MAX && !CTRL.test(n);

// ---------- protocolo (canal de dados convidado <-> anfitrião) ----------
const eId = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x);
const eHex = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
// ID de rede fixo do anfitrião (D5): 'ryvo-' + os 32 primeiros hex da impressão (37 caracteres, passa eId). Só endereça;
// quem prova identidade é a impressão INTEIRA, conferida no SDP (confere). Entrada que não é 64 hex minúsculos: null.
export const idFixo = fp => (eHex(fp) ? 'ryvo-' + fp.slice(0, 32) : null);
const exato = (o, chaves) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join() === [...chaves].sort().join();
const membro = m => exato(m, ['id', 'fp', 'nome']) && eId(m.id) && eHex(m.fp) && nomeValido(m.nome);
const telaDe = x => x === null || (exato(x, ['id', 'nome']) && eId(x.id) && nomeValido(x.nome));
const sdpOk = d => exato(d, ['type', 'sdp']) && (d.type === 'offer' || d.type === 'answer') && typeof d.sdp === 'string' && d.sdp.length <= 30000;
const iceOk = d => exato(d, ['candidate', 'sdpMid', 'sdpMLineIndex']) && typeof d.candidate === 'string' && d.candidate.length <= 2000
  && (d.sdpMid === null || (typeof d.sdpMid === 'string' && d.sdpMid.length <= 64)) && (d.sdpMLineIndex === null || Number.isInteger(d.sdpMLineIndex));
const negOk = m => exato(m, ['t', 'd']) && (exato(m.d, ['desc']) ? sdpOk(m.d.desc) : exato(m.d, ['ice']) && iceOk(m.d.ice));
const soT = m => exato(m, ['t']);
const DO_CONVIDADO = {
  entrar: m => exato(m, ['t', 'nome', 'codigo']) && nomeValido(m.nome) && typeof m.codigo === 'string' && m.codigo.length >= 1 && m.codigo.length <= 12,
  membro: m => exato(m, ['t', 'nome']) && nomeValido(m.nome), // "sou membro, deixe-me entrar sem código"; a impressão NÃO vai na mensagem (o anfitrião a lê do SDP)
  sondar: soT, // só quer saber de presença
  pegar: soT, soltar: soT, sair: soT, neg: negOk,
};
const DO_ANFITRIAO = {
  errado: soT, trancada: soT, cheia: soT, espera: soT, recusado: soT, fim: soT, neg: negOk,
  pedeCodigo: soT, // não confirmei sua participação: mande `entrar`
  presenca: m => exato(m, ['t', 'dentro']) && (m.dentro === null || (Array.isArray(m.dentro) && m.dentro.length <= TETO && m.dentro.every(nomeValido))),
  aceito: m => exato(m, ['t', 'eu', 'membros', 'tela']) && eId(m.eu) && Array.isArray(m.membros) && m.membros.length <= TETO && m.membros.every(membro) && telaDe(m.tela),
  chegou: m => exato(m, ['t', 'id', 'fp', 'nome']) && membro({ id: m.id, fp: m.fp, nome: m.nome }),
  saiu: m => exato(m, ['t', 'id']) && eId(m.id),
  tela: m => exato(m, ['t', 'id', 'nome']) && ((m.id === null && m.nome === null) || (eId(m.id) && nomeValido(m.nome))),
};
// de: 'convidado' (quem envia é o convidado) ou 'anfitriao'. true só para mensagem do protocolo, com campos exatos.
export const valida = (m, de) => {
  if (m === null || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return false;
  const tab = de === 'convidado' ? DO_CONVIDADO : DO_ANFITRIAO;
  return Object.hasOwn(tab, m.t) && tab[m.t](m);
};
// Uma conexão faz uma coisa só: entrar por código, entrar como membro ou sondar. `feito` é o que ela já fez (null, 'entrar', 'membro'
// ou 'sondar'); `t` é o que chegou agora. Repetir o mesmo não é mistura. `membro` -> `entrar` só vale depois de o anfitrião mandar pedeCodigo.
export const mistura = (feito, t, pediuCodigo = false) => {
  if (feito === null || feito === t) return false;
  return !(feito === 'membro' && t === 'entrar' && pediuCodigo);
};
// O anfitrião monta o membro com a impressão que ELE leu do SDP; o convidado não tem como declarar a dele.
export const montaMembro = (id, nome, sdp) => {
  const fp = fpUnico(sdp);
  return fp ? { id, fp, nome } : null;
};

// ---------- allowlist (resposta do Apps Script) ----------
// 'sim' só para o objeto exato {"ok":true}; 'nao' só para {"ok":false}; qualquer outra coisa é 'falha' (falha fechada).
export const veredito = texto => {
  let o;
  try { o = JSON.parse(texto); } catch { return 'falha'; }
  if (!exato(o, ['ok'])) return 'falha';
  return o.ok === true ? 'sim' : o.ok === false ? 'nao' : 'falha';
};

// ---------- certificado ----------
export const certExpirado = (expires, agora = Date.now()) => !(typeof expires === 'number' && Number.isFinite(expires) && expires > agora);
export const dataBr = ms => {
  const d = new Date(ms), z = n => String(n).padStart(2, '0');
  return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()}`;
};

// ---------- estado da sala (só no anfitrião) ----------
export class Sala {
  constructor(idAnf, nomeAnf, fpAnf) {
    this.membros = new Map([[idAnf, { id: idAnf, nome: nomeAnf, fp: fpAnf }]]);
    this.pend = new Map(); // id -> 'novo' (ainda sem código) | 'espera' (código certo, aguardando Aceitar)
    this.erros = 0;
    this.tela = null; // {id, nome} de quem compartilha, ou null
  }
  chega(id) { if (this.pend.size >= PENDENTES) return false; this.pend.set(id, 'novo'); return true; }
  // Uma tentativa por conexão (quem chama garante). 'trancada' vale mesmo para código certo.
  tenta(certo) {
    if (this.erros >= ERROS_MAX) return 'trancada';
    if (certo) return 'ok';
    this.erros++;
    return this.erros >= ERROS_MAX ? 'trancada' : 'errado';
  }
  // Código certo: 'cheia' (sai da fila) ou 'espera'. Código errado nunca chega aqui, então 'cheia' não vaza.
  espera(id) {
    if (this.pend.get(id) !== 'novo') return 'nao';
    if (this.membros.size >= TETO) { this.pend.delete(id); return 'cheia'; }
    this.pend.set(id, 'espera');
    return 'espera';
  }
  // `de` = o estado exigido em `pend`: 'espera' (passou pelo código e o anfitrião aceitou) ou 'novo' (membro: sem fila, sem código).
  entra(de, id, nome, fp) {
    if (this.pend.get(id) !== de) return 'nao';
    this.pend.delete(id);
    if (this.membros.size >= TETO) return 'cheia';
    this.membros.set(id, { id, nome, fp });
    return 'ok';
  }
  aceita(id, nome, fp) { return this.entra('espera', id, nome, fp); }
  admite(id, nome, fp) { return this.entra('novo', id, nome, fp); } // não toca `erros`: o membro não gasta tentativa do código
  sai(id) { this.pend.delete(id); return this.membros.delete(id); }
  pegar(id) { const m = this.membros.get(id); if (!m) return false; this.tela = { id, nome: m.nome }; return true; }
  soltar(id) { if (this.tela?.id !== id) return false; this.tela = null; return true; }
}

// Cache dos vereditos do script só para a SONDA (nunca para `membro`: a revogação vale na próxima entrada). Guarda a PROMESSA, então
// sondas simultâneas da mesma impressão compartilham uma consulta. 'falha' não fica no cache. Excedente de consultas em voo: null.
export const CACHE_TTL_MS = 300000;
export const CACHE_MAX = 50;
export const EM_VOO_MAX = 3;
export class CacheMembros {
  constructor() { this.m = new Map(); this.voo = 0; }
  // `pergunta(fp)` devolve uma Promise de 'sim' | 'nao' | 'falha'. Devolve a Promise do veredito, ou null (teto de consultas em voo).
  consulta(fp, agora, pergunta) {
    const e = this.m.get(fp);
    if (e && e.ate > agora) return e.p;
    if (this.voo >= EM_VOO_MAX) return null;
    this.voo++;
    const p = pergunta(fp);
    this.m.delete(fp);
    this.m.set(fp, { p, ate: agora + CACHE_TTL_MS });
    while (this.m.size > CACHE_MAX) this.m.delete(this.m.keys().next().value);
    p.then(v => { this.voo--; if (v === 'falha' && this.m.get(fp)?.p === p) this.m.delete(fp); }, () => { this.voo--; this.m.delete(fp); });
    return p;
  }
}

// Chamada de vídeo recebida: só do compartilhador atual da lista, e só se o SDP trouxer a impressão listada dele.
export const chamadaOk = (tela, membros, de, sdp) => !!tela && tela.id === de && confere(sdp, membros.find(m => m.id === de)?.fp);

// ---------- banda do compartilhador ----------
const virgula = n => String(n).replace('.', ',');
export const custoBanda = (espectadores, preset) => {
  const mbps = PRESETS[preset].mbps, total = espectadores * mbps;
  return { total, texto: espectadores > 0 ? `${espectadores} ${espectadores === 1 ? 'pessoa' : 'pessoas'} × ${virgula(mbps)} Mbps = ${virgula(total)} Mbps de upload` : '' };
};

// ---------- salas conhecidas (localStorage['ryvo.salas']) ----------
// [{k, nome}]: impressão do anfitrião (64 hex; endereço, não segredo) e o nome que ele declarou. Lê no máximo SALAS_MAX itens
// válidos; texto que não é JSON de lista vira []. A mesma nomeValido do protocolo vale aqui (R10+2).
export const SALAS_MAX = 12;
export const lerSalas = texto => {
  let a;
  try { a = JSON.parse(texto); } catch { return []; }
  if (!Array.isArray(a)) return [];
  const saida = [];
  for (const x of a) {
    if (saida.length >= SALAS_MAX) break;
    if (exato(x, ['k', 'nome']) && eHex(x.k) && nomeValido(x.nome)) saida.push({ k: x.k, nome: x.nome });
  }
  return saida;
};
// Põe (ou atualiza) a sala no começo da lista, sem repetir a impressão e sem passar de SALAS_MAX. Entrada inválida: a lista como estava.
export const guardaSala = (lista, k, nome) => (eHex(k) && nomeValido(nome) ? [{ k, nome }, ...lista.filter(s => s.k !== k)].slice(0, SALAS_MAX) : lista);

// ---------- pedir acesso (D7) ----------
// Texto que o admin recebe pelo WhatsApp. null se nome, aparelho (1 a 24, sem controle/invisível) ou impressão forem inválidos.
export const textoPedido = (nome, aparelho, fp) => (nomeValido(nome) && nomeValido(aparelho) && eHex(fp)
  ? `RYVO: pedido de acesso\nNome: ${nome}\nAparelho: ${aparelho}\nID: ${fp}` : null);
// Sem número: o WhatsApp abre com o texto pronto e a pessoa escolhe o admin nos contatos. Assim nenhum telefone fica público no código.
export const urlPedido = texto => `https://wa.me/?text=${encodeURIComponent(texto)}`;
