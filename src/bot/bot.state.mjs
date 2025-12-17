export const botState = {
  sock: null,
  status: 'disconnected',
  isConnecting: false,
  qrCodeSVG: '',
  monitoredJIDs: [],
  chatsSynchronized: false,
  syncProgress: { current: 0, total: 0, status: 'idle' }
};

let ioInstance = null;

export function initSocket(io) {
  ioInstance = io;

  io.on('connection', socket => {
    socket.emit('status', botState.status);
    if (botState.qrCodeSVG) socket.emit('qr', botState.qrCodeSVG);
  });
}

export function emit(event, payload) {
  if (ioInstance) ioInstance.emit(event, payload);
}
