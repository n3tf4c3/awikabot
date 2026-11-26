#!/bin/sh
# Entrada do contêiner da prova. Só faz algo numa máquina em que um antivírus ou um proxy abre o
# TLS e apresenta um certificado próprio: junta esse certificado, montado em
# /etc/awika/ca-extra.pem, ao pacote do sistema e aponta as CLIs para o resultado. Sem o arquivo,
# ou com ele vazio, passa direto. No Pi não há nada disso.
if [ -s /etc/awika/ca-extra.pem ]; then
  cat /etc/ssl/certs/ca-certificates.crt /etc/awika/ca-extra.pem > /tmp/awika-ca.pem
  export CODEX_CA_CERTIFICATE=/tmp/awika-ca.pem
  export SSL_CERT_FILE=/tmp/awika-ca.pem
  export NODE_EXTRA_CA_CERTS=/etc/awika/ca-extra.pem
fi
exec "$@"
