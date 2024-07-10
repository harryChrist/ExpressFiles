const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const BASE_DIR = path.resolve(__dirname);

// Função para resolver caminhos relativos ao diretório base do projeto
const resolvePath = (relativePath) => {
  const resolvedPath = path.resolve(BASE_DIR, relativePath);
  if (!resolvedPath.startsWith(BASE_DIR)) {
    throw new Error('Tentativa de acesso fora do diretório base');
  }
  return resolvedPath;
};

// Função para criar recursivamente diretórios
const criarDiretoriosRecursivamente = (diretorio) => {
  if (!diretorio) {
    console.error('Diretório inválido:', diretorio);
    return; // Verificação adicional para diretório vazio
  }
  
  const partes = diretorio.split(path.sep);
  let caminhoAcumulado = path.isAbsolute(diretorio) ? path.sep : '';

  console.log('Partes do diretório:', partes); // Log das partes do diretório
  for (let i = 0; i < partes.length; i++) {
    caminhoAcumulado = path.join(caminhoAcumulado, partes[i]);
    caminhoAcumulado = resolvePath(caminhoAcumulado); // Resolve para o caminho base do projeto
    console.log('Criando caminho:', caminhoAcumulado); // Log do caminho sendo criado
    if (!fs.existsSync(caminhoAcumulado)) {
      fs.mkdirSync(caminhoAcumulado);
    }
  }
};

// Configuração do Multer para armazenar imagens temporariamente
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const pastaTemp = resolvePath('public/temp');

    // Cria recursivamente o diretório temporário se não existir
    criarDiretoriosRecursivamente(pastaTemp);

    cb(null, pastaTemp);
  },
  filename: function (req, file, cb) {
    const nome = file.originalname;
    cb(null, nome);
  }
});

const upload = multer({ storage: storage });

// Configuração do Express para servir arquivos estáticos
app.use(express.static(resolvePath('public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rota para página inicial
app.get('/', (req, res) => {
  res.sendFile(resolvePath('index.html'));
});

// Rota para lidar com o envio de imagens e texto
app.post('/upload', upload.single('imagem'), (req, res) => {
  const { name, folders } = req.body;
  if (!name || !folders) {
    return res.status(400).json({ error: 'Os campos "name" e "folders" são obrigatórios.' });
  }

  console.log('Folders:', folders);
  console.log('Name:', name);
  console.log('File:', req.file.originalname);

  const tempFilePath = resolvePath(path.join('public/temp', req.file.originalname));
  const finalDir = resolvePath(path.join('public', folders));
  const finalFilePath = resolvePath(path.join(finalDir, `${name}${path.extname(req.file.originalname)}`));

  console.log('Temp File Path:', tempFilePath);
  console.log('Final Dir:', finalDir);
  console.log('Final File Path:', finalFilePath);

  // Verificação adicional para garantir que o diretório final esteja dentro do diretório base
  if (!finalDir) {
    console.error('Diretório final inválido:', finalDir);
    return res.status(400).json({ error: 'Diretório final inválido.' });
  }

  // Cria recursivamente o diretório final se não existir
  criarDiretoriosRecursivamente(finalDir);

  // Move o arquivo do diretório temporário para o diretório final
  fs.rename(tempFilePath, finalFilePath, (err) => {
    if (err) {
      console.error('Erro ao mover o arquivo:', err);
      return res.status(500).json({ error: 'Erro ao mover o arquivo.' });
    }
    res.json({
      message: 'Upload realizado com sucesso!',
      file: finalFilePath,
      body: req.body
    });
  });
});

// Rota para acessar imagens sem extensão na URL
app.get('/image/:name', (req, res) => {
  const name = req.params.name;
  const directoryPath = resolvePath('public/image');
  const possibleExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']; // Adicione mais extensões conforme necessário

  for (const ext of possibleExtensions) {
    const filePath = resolvePath(path.join(directoryPath, `${name}${ext}`));
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