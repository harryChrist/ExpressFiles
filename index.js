const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

const possibleExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.txt', '.pdf'];

// Função para criar recursivamente diretórios
const criarDiretoriosRecursivamente = (diretorio) => {
  if (!diretorio) return; // Adiciona verificação para diretório vazio
  const partes = diretorio.split('/');
  fs.mkdirSync(diretorio, { recursive: true });
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

// Função para mover e substituir arquivos independentemente da extensão
const moverArquivo = (tempFilePath, finalDir, name, res) => {
  const newFileExtension = path.extname(tempFilePath);
  const finalFilePath = path.join(finalDir, `${name}${newFileExtension}`);

  // Remover arquivos antigos
  for (const ext of possibleExtensions) {
    const oldFilePath = path.join(finalDir, `${name}${ext}`);
    if (fs.existsSync(oldFilePath)) {
      try {
        fs.unlinkSync(oldFilePath); // Remove o arquivo antigo, independentemente da extensão
      } catch (err) {
        console.error(`Erro ao remover o arquivo antigo: ${oldFilePath}`, err);
      }
    }
  }

  // Cria o diretório se não existir
  criarDiretoriosRecursivamente(finalDir);

  // Mover o novo arquivo para o destino
  fs.rename(tempFilePath, finalFilePath, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao mover o arquivo.' + err });
    }
    res.json({
      message: 'Upload realizado com sucesso!',
      file: finalFilePath
    });
  });
};

const obterDiretorioDestino = (tipo, id) => {
  switch (tipo) {
    case 'user':
      return `public/user/${id}`;
    case 'assets':
      return 'public/assets';
    case 'novel':
      return `public/novel/${id}`;
    case 'novel-assets':
      return `public/novel/${id}/assets`;
    default:
      throw new Error('Tipo de upload inválido.');
  }
};


// Rota para lidar com o envio de imagens e texto
app.post('/upload', upload.single('imagem'), (req, res) => {
  const { name, tipo, id } = req.body;

  // Verificação do campo "tipo"
  if (!tipo) {
    return res.status(400).json({ error: 'O campo "tipo" é obrigatório.' });
  }

  // Verificação do campo "name"
  if (!name) {
    return res.status(400).json({ error: 'O campo "name" é obrigatório.' });
  }

  // Verificação do arquivo de upload
  if (!req.file) {
    return res.status(400).json({ error: 'O campo "imagem" é obrigatório.' });
  }

  let finalDir;
  try {
    finalDir = path.join(__dirname, obterDiretorioDestino(tipo, id));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const tempFilePath = path.join(__dirname, 'public/temp', req.file.originalname);

  moverArquivo(tempFilePath, finalDir, name, res);
});

// Função para servir imagens ou arquivos
const servirArquivos = (directory, req, res) => {
  const name = req.params.name;

  for (const ext of possibleExtensions) {
    const filePath = path.join(directory, `${name}${ext}`);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
  }

  res.status(404).send('Arquivo não encontrado');
};

// Rota para imagens
app.get('/image/:name', (req, res) => {
  const directoryPath = path.join(__dirname, 'public/image');
  servirArquivos(directoryPath, req, res);
});

// Rota para user profile
app.get('/user/:id/:name', (req, res) => {
  const directoryPath = path.join(__dirname, `public/user/${req.params.id}`);
  servirArquivos(directoryPath, req, res);
});

// Rota para assets
app.get('/assets/:name', (req, res) => {
  const directoryPath = path.join(__dirname, 'public/assets');
  servirArquivos(directoryPath, req, res);
});

// Rota para novel
app.get('/novel/:id/:name', (req, res) => {
  const directoryPath = path.join(__dirname, `public/novel/${req.params.id}`);
  servirArquivos(directoryPath, req, res);
});

// Rota para assets de novel
app.get('/novel/:id/assets/:name', (req, res) => {
  const directoryPath = path.join(__dirname, `public/novel/${req.params.id}/assets`);
  servirArquivos(directoryPath, req, res);
});

// Inicia o servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
