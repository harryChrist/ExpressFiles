const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const compression = require('compression');
const { body, validationResult } = require('express-validator');
const cors = require('cors'); // Adicione esta linha

const app = express();

const possibleExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.txt', '.pdf'];

// Configurar CORS
app.use(cors()); // Adicione esta linha

const criarDiretoriosRecursivamente = (diretorio) => {
  if (!diretorio) return;
  fs.mkdirSync(diretorio, { recursive: true });
};

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let pastaBase = 'public/temp';
    if (!fs.existsSync(pastaBase)) {
      fs.mkdirSync(pastaBase, { recursive: true });
    }
    cb(null, pastaBase);
  },
  filename: function (req, file, cb) {
    const nome = req.body.name || file.originalname;
    cb(null, nome);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    const fileExt = path.extname(file.originalname).toLowerCase();
    if (!possibleExtensions.includes(fileExt)) {
      return cb(new Error('Tipo de arquivo não permitido'), false);
    }
    cb(null, true);
  }
});

app.use(helmet());
app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const moveFile = (tempFilePath, finalDir, name, res) => {
  const newFileExtension = path.extname(tempFilePath);
  const finalFilePath = path.join(finalDir, `${name}${newFileExtension}`);

  for (const ext of possibleExtensions) {
    const oldFilePath = path.join(finalDir, `${name}${ext}`);
    if (fs.existsSync(oldFilePath)) {
      try {
        fs.unlinkSync(oldFilePath);
      } catch (err) {
        console.error(`Erro ao remover o arquivo antigo: ${oldFilePath}`, err);
      }
    }
  }

  criarDiretoriosRecursivamente(finalDir);

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
      if (!id) throw new Error('O campo "id" é obrigatório para o tipo "user".');
      return `public/user/${id}`;
    case 'assets':
      return 'public/assets';
    case 'novel':
      if (!id) throw new Error('O campo "id" é obrigatório para o tipo "novel".');
      return `public/novel/${id}`;
    case 'novel-assets':
      if (!id) throw new Error('O campo "id" é obrigatório para o tipo "novel-assets".');
      return `public/novel/${id}/assets`;
    default:
      throw new Error('Tipo de upload inválido.');
  }
};

app.post('/upload', 
  upload.single('imagem'), 
  body('name').notEmpty().withMessage('O campo "name" é obrigatório.'),
  body('type').notEmpty().withMessage('O campo "type" é obrigatório.'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, type, id } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'O campo "imagem" é obrigatório.' });
    }

    let finalDir;
    try {
      finalDir = path.join(__dirname, obterDiretorioDestino(type, id));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const tempFilePath = path.join(__dirname, 'public/temp', req.file.originalname);

    moveFile(tempFilePath, finalDir, name, res);
  }
);

const listarArquivos = (directory) => {
  if (!fs.existsSync(directory)) {
    return [];
  }
  
  return fs.readdirSync(directory).map(file => {
    const filePath = path.join(directory, file);
    const stats = fs.statSync(filePath);
    const fileExtension = path.extname(file);
    const fileName = path.basename(file, fileExtension);
    
    return {
      name: fileName,       // Nome do arquivo sem a extensão
      archive: file,        // Nome completo do arquivo com a extensão
      size: stats.size,     // Tamanho do arquivo
      created: stats.birthtime, // Data de criação
      modified: stats.mtime // Data de modificação
    };
  });
};


app.get('/user/:id/files', (req, res) => {
  const directoryPath = path.join(__dirname, `public/user/${req.params.id}`);
  const files = listarArquivos(directoryPath);
  res.json(files);
});

app.get('/assets/files', (req, res) => {
  const directoryPath = path.join(__dirname, 'public/assets');
  const files = listarArquivos(directoryPath);
  res.json(files);
});

app.get('/novel/:id/files', (req, res) => {
  const directoryPath = path.join(__dirname, `public/novel/${req.params.id}`);
  const files = listarArquivos(directoryPath);
  res.json(files);
});

app.get('/novel/:id/assets/files', (req, res) => {
  const directoryPath = path.join(__dirname, `public/novel/${req.params.id}/assets`);
  const files = listarArquivos(directoryPath);
  res.json(files);
});

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

app.get('/image/:name', (req, res) => {
  const directoryPath = path.join(__dirname, 'public/image');
  servirArquivos(directoryPath, req, res);
});

app.get('/user/:id/:name', (req, res) => {
  const directoryPath = path.join(__dirname, `public/user/${req.params.id}`);
  servirArquivos(directoryPath, req, res);
});

app.get('/assets/:name', (req, res) => {
  const directoryPath = path.join(__dirname, 'public/assets');
  servirArquivos(directoryPath, req, res);
});

app.get('/novel/:id/:name', (req, res) => {
  const directoryPath = path.join(__dirname, `public/novel/${req.params.id}`);
  servirArquivos(directoryPath, req, res);
});

app.get('/novel/:id/assets/:name', (req, res) => {
  const directoryPath = path.join(__dirname, `public/novel/${req.params.id}/assets`);
  servirArquivos(directoryPath, req, res);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
