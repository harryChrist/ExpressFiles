const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// Função para criar recursivamente diretórios
const criarDiretoriosRecursivamente = (diretorio) => {
  if (!diretorio) return; // Adiciona verificação para diretório vazio
  const partes = diretorio.split('/');
  for (let i = 1; i <= partes.length; i++) {
    const caminho = partes.slice(0, i).join('/');
    if (!fs.existsSync(caminho)) {
      fs.mkdirSync(caminho);
    }
  }
};

// Configuração do Multer para armazenar imagens
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Pasta base para armazenamento de imagens
    let pastaBase = 'public/temp';

    // Cria recursivamente o diretório se não existir
    if (!fs.existsSync(pastaBase)) {
      fs.mkdirSync(pastaBase, { recursive: true });
    }

    cb(null, pastaBase);
  },
  filename: function (req, file, cb) {
    // Define o nome do arquivo como o nome fornecido no campo 'nome' ou o nome original do arquivo
    const nome = req.body.name || file.originalname;
    cb(null, nome);
  }
});


const upload = multer({ storage: storage });

// Configuração do Express para servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rota para página inicial
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Rota para lidar com o envio de imagens e texto
app.post('/upload', upload.single('imagem'), (req, res) => {
  const { name, folders } = req.body;
  if (!folders) {
    return res.status(400).json({ error: 'O campo "folders" é obrigatório.' });
  }

  const tempFilePath = path.join(__dirname, 'public/temp', req.file.originalname);
  const finalDir = path.join(__dirname, 'public', folders);
  const finalFilePath = path.join(finalDir, `${name}${path.extname(req.file.originalname)}`);
  
  console.log('Folders:', folders);
  console.log('Name:', name);
  console.log('File:', req.file.originalname);
  console.log('Dir File:', finalDir);
  console.log('Final File:', finalFilePath);

  // Cria recursivamente o diretório final se não existir
  criarDiretoriosRecursivamente(finalDir);

  // Move o arquivo do diretório temporário para o diretório final
  fs.rename(tempFilePath, finalFilePath, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao mover o arquivo.' });
    }
    res.json({
      message: 'Upload realizado com sucesso!',
      file: finalFilePath,
      body: req.body
    });
  });
});

app.get('/image/:name', (req, res) => {
  const name = req.params.name;
  const directoryPath = path.join(__dirname, 'public/image');
  const possibleExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']; // Adicione mais extensões conforme necessário

  for (const ext of possibleExtensions) {
    const filePath = path.join(directoryPath, `${name}${ext}`);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
  }

  res.status(404).send('Imagem não encontrada');
});

// Inicia o servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
