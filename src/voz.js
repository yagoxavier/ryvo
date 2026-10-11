// Voz: renegociação própria (perfect negotiation) pelo canal de dados que o PeerJS já abriu.
// O PeerJS 1.5.4 não renegocia (medido em scratch/S01-voz/resultado.md §C), então a RTCPeerConnection da
// DataConnection é usada direto: offer/answer/ICE vão como mensagens `neg` pelo canal, já verificado.
// O anfitrião é o lado "impolite" (polite=false); o convidado é "polite".
export class Voz {
  constructor(pc, polite, envia) {
    this.pc = pc; this.polite = polite; this.envia = envia;
    this.fazendo = false; this.ignora = false; this.aoTrilha = () => {};
    // Troca o handler do PeerJS (que mandaria candidatos pelo servidor público) pelo canal de dados.
    pc.onicecandidate = e => e.candidate && envia({ ice: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } });
    pc.addEventListener('negotiationneeded', async () => {
      try {
        this.fazendo = true;
        await pc.setLocalDescription();
        envia({ desc: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      } catch { /* conexão fechando */ } finally { this.fazendo = false; }
    });
    pc.addEventListener('track', e => e.track.kind === 'audio' && this.aoTrilha(e.track));
  }
  // d = {desc} ou {ice}, já validado por valida().
  async recebe(d) {
    const pc = this.pc;
    try {
      if (d.desc) {
        const colisao = d.desc.type === 'offer' && (this.fazendo || pc.signalingState !== 'stable');
        this.ignora = !this.polite && colisao;
        if (this.ignora) return;
        await pc.setRemoteDescription(d.desc);
        if (d.desc.type === 'offer') {
          await pc.setLocalDescription();
          this.envia({ desc: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        }
      } else if (d.ice) {
        try { await pc.addIceCandidate(d.ice); } catch (e) { if (!this.ignora) throw e; }
      }
    } catch { /* conexão fechando ou descrição fora de hora: a próxima negociação refaz */ }
  }
}

// Toca uma trilha remota. Sem um <audio> tocando, o Chrome não entrega o áudio remoto (medido no experimento).
const tocando = new Set();
export const tocar = trilha => {
  const a = new Audio();
  a.srcObject = new MediaStream([trilha]);
  a.play().catch(() => {});
  tocando.add(a);
  globalThis.__RYVO_TEST__?.trilhas.push(trilha);
};
