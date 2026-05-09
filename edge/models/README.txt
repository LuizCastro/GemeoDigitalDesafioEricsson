# Pasta de modelos YOLO (.pt)

Esta pasta deve conter o(s) arquivo(s) de modelo YOLO usados para inferência pelo edge (exemplo: best.pt).

- Os arquivos .pt estão no .gitignore e não são versionados pelo git.
- Faça upload manualmente do(s) modelo(s) para esta pasta no servidor de produção.
- Após o upload, reinicie o serviço do edge para ativar a inferência:
  sudo systemctl restart desafioericsson-edge.service

Exemplo de download de modelo público YOLOv8:
wget https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8n.pt -O models/best.pt

Nunca adicione arquivos .pt ao repositório git.
