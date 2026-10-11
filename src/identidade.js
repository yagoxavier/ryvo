// Identidade e acesso ao mundo de fora: certificado persistente do anfitrião, allowlist (Apps Script) e opções do PeerJS.
import { certExpirado, veredito, lerSalas } from './puro.js';

// URL do Apps Script que responde {"ok":true}/{"ok":false} para ?id=<64 hex>. Não é segredo (SPEC §5).
// App da Web de apps-script/allowlist.gs. Não é segredo (SPEC §5): só responde sim/não para um ID.
const URL_ALLOW = 'https://script.google.com/macros/s/AKfycbxNK7oJcXthAPy91kcB-w8h6W6tb-UKHrfwcHfpuU1RM6ddpORuvzb0-lS9yzh5111Fww/exec';
const ALLOW_MS = 10000;

const abre = () => new Promise((ok, no) => {
  const r = indexedDB.open('ryvo', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('id');
  r.onsuccess = () => ok(r.result);
  r.onerror = () => no(r.error);
});
const tx = (modo, f) => abre().then(db => new Promise((ok, no) => {
  const t = db.transaction('id', modo), rq = f(t.objectStore('id'));
  t.oncomplete = () => { db.close(); ok(rq.result); };
  t.onerror = () => no(t.error);
}));
const novoCert = () => RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256', expires: 365 * 864e5 });
const fpDoCert = c => c.getFingerprints().find(f => f.algorithm === 'sha-256').value.replace(/:/g, '').toLowerCase();
// O Chrome recusa criar RTCPeerConnection com certificado vencido (InvalidAccessError: Expired certificate(s)).
const vencidoNoChrome = cert => { try { new RTCPeerConnection({ certificates: [cert] }).close(); return false; } catch { return true; } };

// Carrega (ou cria) o certificado persistente (anfitrião, membro, Pedir acesso). Vencido: grava um novo e devolve {expirado:{em, fp}, cert} com o ID NOVO.
export const preparaCert = async () => {
  let cert = await tx('readonly', s => s.get('cert')).catch(() => undefined);
  if (cert && (certExpirado(cert.expires) || vencidoNoChrome(cert))) {
    const antigo = cert.expires;
    cert = await novoCert();
    await tx('readwrite', s => s.put(cert, 'cert'));
    return { expirado: { em: antigo, fp: fpDoCert(cert) }, cert };
  }
  if (!cert) { cert = await novoCert(); await tx('readwrite', s => s.put(cert, 'cert')); }
  return { cert, fp: fpDoCert(cert) };
};

// Visitante (sem certificado persistente) e fase 1 da sonda de presença: certificado só da sessão, nunca gravado.
export const certDaSessao = () => RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });

// Certificado persistente VÁLIDO, sem criar nem renovar nada (a presença não pode apagar o aviso de vencimento da abertura de sala).
export const certSeExiste = async () => {
  if (!(await temCert())) return null;
  const cert = await tx('readonly', s => s.get('cert')).catch(() => undefined);
  return cert && !certExpirado(cert.expires) && !vencidoNoChrome(cert) ? { cert } : null;
};

// Certificado do convidado (D11): persistente SÓ para quem já pediu acesso; visitante usa um da sessão e nada é gravado.
// Persistente vencido: renova (grava o novo, como na abertura de sala) e segue como visitante; `renovado` = validade antiga, para avisar.
export const certDoConvidado = async () => {
  if (!(await temCert())) return { cert: await certDaSessao(), persistente: false };
  const r = await preparaCert();
  return r.expirado ? { cert: r.cert, persistente: false, renovado: r.expirado.em } : { cert: r.cert, persistente: true };
};

// Salas conhecidas (D8): [{k, nome}] em localStorage['ryvo.salas'], validado na leitura (lerSalas). A impressão do anfitrião não é segredo.
export const salasConhecidas = () => { try { return lerSalas(localStorage.getItem('ryvo.salas')); } catch { return []; } };
export const gravaSalas = lista => { try { localStorage.setItem('ryvo.salas', JSON.stringify(lista)); } catch {} };

// Ponto de contato com o administrador pelo WhatsApp: só dígitos, com DDI. DECISÃO DO USUÁRIO: este número é inválido de propósito;
// trocar pelo real antes de publicar (fora da automação).
export const ADMIN_WA = '5500000000000';

// Há certificado persistente neste aparelho? NÃO cria o banco: indexedDB.open cria um banco vazio se ele não existe,
// e o visitante nunca pode deixar rastro (D11, S01 R4neg3). Por isso olha indexedDB.databases() antes de abrir.
export const temCert = async () => {
  try { if (!(await indexedDB.databases()).some(d => d.name === 'ryvo')) return false; } catch { return false; }
  return !!(await tx('readonly', s => s.get('cert')).catch(() => undefined));
};

// "Sair do grupo neste aparelho": apaga o certificado, a lista de salas e o token. `ryvo.nome` fica. Sem certificado, não faz nada.
export const sairDoGrupo = async () => {
  if (!(await temCert())) return;
  await tx('readwrite', s => s.delete('cert')).catch(() => {});
  try { localStorage.removeItem('ryvo.salas'); sessionStorage.removeItem('ryvo.token'); } catch {}
};

// 'sim' | 'nao' | 'falha'. Qualquer erro, timeout ou resposta fora do formato é 'falha' (falha fechada).
export const consultaAllow = async id => {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ALLOW_MS);
  try {
    const r = await fetch(`${URL_ALLOW}?id=${encodeURIComponent(id)}`, { signal: ac.signal });
    return veredito(await r.text());
  } catch { return 'falha'; } finally { clearTimeout(t); }
};

// Opções do `new Peer`: servidores STUN/TURN padrão do PeerJS + o certificado. Em teste, __RYVO_TEST__.peerOpts
// (instalado pelo driver CDP, nunca presente em produção) troca o servidor de sinalização e zera os ICE servers.
export const opcoesPeer = (cert, token) => {
  const t = globalThis.__RYVO_TEST__?.peerOpts ?? {};
  return { ...t, ...(token ? { token } : {}), config: { ...peerjs.util.defaultConfig, ...t.config, certificates: [cert] } };
};

// Token da sessão do PeerJS (D10): 32 hex em sessionStorage, NUNCA em localStorage. Quem o tem retoma o ID fixo e derruba o dono,
// mas não passa em `confere`: vazar o token é negação de serviço, não personificação. Sem sessionStorage: undefined (o PeerJS sorteia um).
export const tokenSessao = () => {
  try {
    let t = sessionStorage.getItem('ryvo.token');
    if (!/^[0-9a-f]{32}$/.test(t ?? '')) {
      t = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem('ryvo.token', t);
    }
    return t;
  } catch { return undefined; }
};
