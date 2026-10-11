// Presença (D8): de tempos em tempos, sonda as salas que este aparelho conhece e diz quais estão abertas e quem está dentro.
// Sem DOM (quem desenha é o app.js). A sonda é uma conexão curta que só manda `sondar` e espera `presenca`: nunca `entrar`, nunca `membro`.
import { PRESENCA_MS, SONDA_MS, idFixo, confere, valida } from './puro.js';
import { opcoesPeer, salasConhecidas, certDaSessao } from './identidade.js';

// Uma sala: conecta no ID fixo, confere a impressão do SDP com `k` (impostor: nada é enviado), manda `sondar` e espera `presenca`.
// `aguarda` liga o ID da sala ao `fim` desta sonda, porque o erro peer-unavailable chega no Peer, não na conexão.
const sondaUma = (peer, s, aguarda, soConfere = false) => new Promise(ok => {
  const id = idFixo(s.k);
  const c = peer.connect(id, { serialization: 'json' });
  let prazo;
  const fim = (estado, dentro = null) => {
    clearTimeout(prazo);
    aguarda.delete(id);
    ok({ ...s, estado, dentro }); // antes do close: close() dispara o evento 'close' de forma síncrona, e o fim('fechada') aninhado venceria a promessa
    if (c.open) c.close();
  };
  prazo = setTimeout(() => fim('fechada'), SONDA_MS);
  aguarda.set(id, fim);
  c.on('open', () => {
    if (!confere(c.peerConnection.remoteDescription.sdp, s.k)) return fim('fechada');
    if (soConfere) return fim('aberta'); // fase 1: só provou que do outro lado está o dono de k; nada é enviado
    c.send({ t: 'sondar' });
  });
  c.on('data', d => { if (valida(d, 'anfitriao') && d.t === 'presenca') fim('aberta', d.dentro); });
  c.on('close', () => fim('fechada'));
});

// Um Peer aberto com o certificado dado, e o mapa `aguarda` das sondas dele.
const abrePeer = async cert => {
  const peer = new Peer(opcoesPeer(cert)), aguarda = new Map();
  peer.on('error', e => { if (e.type === 'peer-unavailable') aguarda.get(String(e.message).split(' ').pop())?.('fechada'); }); // "Could not connect to peer <id>"
  await new Promise((ok, no) => { peer.on('open', ok); peer.on('error', no); });
  return { peer, aguarda };
};

// Uma rodada em duas fases (M1): quem ocupa o ID fixo sem ser o dono veria o certificado persistente do membro (impressão estável + IP).
// Fase 1: Peer com certificado descartável, só `confere`. Fase 2: o Peer com o certificado persistente, só nas salas que passaram.
// Devolve [{k, nome, estado: 'aberta'|'fechada', dentro: string[]|null}] na ordem de `salas`, ou null se o servidor de sinalização não respondeu.
const sonda = async (cert, salas) => {
  const abertos = [];
  const abre = async c => { const a = await abrePeer(c); abertos.push(a.peer); return a; };
  try {
    const e = await abre(await certDaSessao());
    const provadas = new Set((await Promise.all(salas.map(s => sondaUma(e.peer, s, e.aguarda, true)))).filter(r => r.estado === 'aberta').map(r => r.k));
    const certas = salas.filter(s => provadas.has(s.k));
    const p = certas.length ? await abre(cert) : null;
    const rs = p ? await Promise.all(certas.map(s => sondaUma(p.peer, s, p.aguarda))) : [];
    return salas.map(s => rs.find(r => r.k === s.k) ?? { ...s, estado: 'fechada', dentro: null });
  } catch { return null; } finally { abertos.forEach(p => p.destroy()); }
};

// Liga o ciclo: uma rodada já e outra a cada PRESENCA_MS, só com a tela inicial à vista, a página visível e a lista não vazia.
// `cert` é o certificado persistente (a impressão dele é o que o anfitrião lê para decidir se mostra os nomes).
export const ligaPresenca = ({ cert, ativa, aoMudar }) => {
  let rodando = false;
  const rodada = async () => {
    const salas = salasConhecidas();
    if (rodando || !salas.length || document.visibilityState !== 'visible' || !ativa()) return;
    rodando = true;
    const r = await sonda(cert, salas);
    rodando = false;
    if (r && ativa()) aoMudar(r);
  };
  rodada();
  return setInterval(rodada, PRESENCA_MS);
};
