# Tela Live 2.0

## Rodar
```bash
npm install
npm start
```
Abra http://localhost:3000

## Recursos
- Login e cadastro
- Salas públicas e privadas
- Chat em tempo real
- Lista de membros
- Convite
- Compartilhamento de tela com áudio quando disponível
- Microfone mutável
- 720p/1080p e 30/60 FPS
- WebRTC

## Produção
Use HTTPS/WSS e defina `JWT_SECRET`. Para internet real, especialmente redes restritas, configure um servidor TURN. As contas e salas desta versão são armazenadas em memória, portanto reiniciar o servidor apaga os dados.
