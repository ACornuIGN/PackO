const debug = require('debug')('branch');
const fs = require('fs');
const path = require('path');
const { matchedData } = require('express-validator');
const db = require('../db/db');
const pgClient = require('./pgClient');
const patch = require('./patch');
const cog = require('../cog_path');
const gdalProcessing = require('../gdal_processing');

// Nombre de pixels utilisé pour le buffer d'intersection du merge
const NBPX = 5;
const NOM_VECT_INTER_MERGE = 'intersection_merge';

async function getBranches(req, _res, next) {
  debug('>>GET branches');
  if (req.error) {
    next();
    return;
  }
  const params = matchedData(req);
  const { idCache } = params;
  try {
    const branches = await db.getBranches(req.client, idCache);
    if (this.column) {
      // req.result = { getBranches: branches.map((branch) => branch[this.column]), code: 200 };
      if (!req.result) req.result = {};
      req.result.getBranches = branches.map((branch) => branch[this.column]);
    } else {
      req.result = { json: branches, code: 200 };
    }
  } catch (error) {
    debug(error);
    req.error = error;
  }
  debug('  next>>');
  next();
}

async function postBranch(req, _res, next) {
  debug('>>POST Branch');
  if (req.error) {
    next();
    return;
  }
  const params = matchedData(req);
  const { name, idCache } = params;

  try {
    const idBranch = await db.insertBranch(req.client, name, idCache);
    req.result = { json: { name, id: idBranch }, code: 200 };
  } catch (error) {
    debug(error);
    if (error.constraint === 'branches_name_id_cache_key') {
      req.error = {
        json: {
          msg: 'A branch with this name already exists.',
          function: 'insertBranch',
        },
        code: 406,
      };
    } else {
      req.error = error;
    }
  }
  debug('  next>>');
  next();
}

async function deleteBranch(req, _res, next) {
  debug('>>DELETE branch');
  if (req.error) {
    next();
    return;
  }
  const params = matchedData(req);
  const { idBranch } = params;

  try {
    const branchName = await db.deleteBranch(req.client, idBranch);
    if (branchName === null) {
      req.error = {
        json: {
          msg: `Branch '${idBranch}' can't be deleted.`,
          function: 'deleteBranch',
        },
        code: 406,
      };
    } else {
      req.result = { json: `branche '${branchName}' détruite`, code: 200 };
    }
  } catch (error) {
    debug(error);
    req.error = error;
  }
  debug('  next>>');
  next();
}

async function initMergeBranch(pgClientRequest, nameNewBranch, idBase, cache, overviews) {
  // creation de la nouvelle branche
  const idNewBranch = await db.insertBranch(pgClientRequest, nameNewBranch, cache.id);
  debug('nouvelle branche : ', idNewBranch);
  // reprise des corrections de la base dans cette nouvelle branche
  const patches = await db.getActivePatches(pgClientRequest, idBase);
  let selectedSlabs = new Set();
  patches.features.forEach(async (feature) => {
    // on ajoute les dalles dans la liste des dalles impactées
    feature.properties.slabs.forEach((slab) => {
      selectedSlabs.add(JSON.stringify(slab));
    });
  });
  selectedSlabs = Array.from(selectedSlabs).map((slab) => JSON.parse(slab));
  debug('tuiles a copier : ', selectedSlabs, idBase, idNewBranch);
  // on copie les fichers images dans le cache pour cette nouvelle branche
  selectedSlabs.forEach((slab) => {
    const cogPath = cog.getSlabPath(
      slab[0],
      slab[1],
      slab[2],
      overviews.pathDepth,
    );
    const graphDir = path.join(cache.path, 'graph', cogPath.dirPath);
    const orthoDir = path.join(cache.path, 'ortho', cogPath.dirPath);
    const opiDir = path.join(cache.path, 'opi', cogPath.dirPath);
    debug(orthoDir);
    const arrayLinkOrtho = fs.readdirSync(orthoDir).filter(
      (filename) => (filename.startsWith(`${idBase}_${cogPath.filename}`)),
    );
    const regex = new RegExp(`^${idBase}_`);
    debug(regex);
    arrayLinkOrtho.forEach((file) => {
      const newName = file.replace(regex, `${idNewBranch}_`);
      debug('copy ', file, newName);
      // fs.copyFileSync(path.join(orthoDir, file), path.join(orthoDir, newName));
      const data = fs.readFileSync(path.join(orthoDir, file));
      fs.writeFileSync(path.join(orthoDir, newName), data);
    });
    debug(graphDir);
    const arrayLinkGraph = fs.readdirSync(graphDir).filter(
      (filename) => (filename.startsWith(`${idBase}_${cogPath.filename}`)),
    );
    arrayLinkGraph.forEach((file) => {
      const newName = file.replace(regex, `${idNewBranch}_`);
      debug('copy ', file, newName);
      // fs.copyFileSync(path.join(graphDir, file), path.join(graphDir, newName));
      const data = fs.readFileSync(path.join(graphDir, file));
      fs.writeFileSync(path.join(graphDir, newName), data);
    });
    debug(opiDir);
    const arrayLinkOpi = fs.readdirSync(opiDir).filter(
      (filename) => (filename.startsWith(`${idBase}_${cogPath.filename}`)),
    );
    arrayLinkOpi.forEach((file) => {
      const newName = file.replace(regex, `${idNewBranch}_`);
      debug('copy ', file, newName);
      // fs.copyFileSync(path.join(opiDir, file), path.join(opiDir, newName));
      const data = fs.readFileSync(path.join(opiDir, file));
      fs.writeFileSync(path.join(opiDir, newName), data);
    });
  });
  // on ajoute les patchs dans la BD sur cette nouvelle branche
  for (const feature of patches.features) {
    // on insert ce patch dans les MTD de la branche
    debug(feature.properties);
    const patchInserted = await db.insertPatch(pgClientRequest,
      idNewBranch,
      feature.geometry,
      {
        ref: feature.properties.id_opi,
        sec: feature.properties.id_opisec,
      },
      feature.properties.is_auto);
    const idNewPatch = patchInserted.id_patch;

    const slabs = feature.properties.slabs.map((s) => ({ x: s[0], y: s[1], z: s[2] }));

    // ajouter les slabs correspondant au patch dans la table correspondante
    await db.insertSlabs(pgClientRequest, idNewPatch, slabs);
  }
  return [idNewBranch, patches];
}

function getGeometryFeature(feature, overviews) {
  // verif si déjà passé
  if (feature.geomPolygon) {
    debug(`feature n°${feature.properties.id} à un geomPolygon`);
    return feature;
  }
  // verif si geomtrie est déjà un polygone
  if (feature.geometry.type === 'Polygon') {
    debug(`feature n°${feature.properties.id} à une geometrie Polygon`);
    const geomPolygon = feature.geometry;
    return { ...feature, geomPolygon };
  }
  // récupération de la position des slabs min et max
  let slabXMin;
  let slabYMin;
  let slabXMax;
  let slabYMax;
  for (const coor of feature.geometry.coordinates) {
    if (slabXMin === undefined || slabXMin > coor[0]) {
      [slabXMin] = coor;
    }
    if (slabYMin === undefined || slabYMin > coor[1]) {
      [, slabYMin] = coor;
    }
    if (slabXMax === undefined || slabXMax < coor[0]) {
      [slabXMax] = coor;
    }
    if (slabYMax === undefined || slabYMax < coor[1]) {
      [, slabYMax] = coor;
    }
  }

  // Calcule des coordonnées du polygone englobant
  const xOrigin = overviews.crs.boundingBox.xmin;
  const yOrigin = overviews.crs.boundingBox.ymax;
  const slabWidth = overviews.tileSize.width * overviews.slabSize.width;
  const slabHeight = overviews.tileSize.height * overviews.slabSize.height;
  const resolution = overviews.resolution * 2 ** (overviews.level.max
    - overviews.dataSet.level.max);
  debug(slabXMin, slabYMin, slabXMax, slabYMax, xOrigin,
    yOrigin, slabWidth, slabHeight, resolution);
  const xMin = xOrigin + slabWidth * slabXMin * resolution;
  const yMin = yOrigin - slabHeight * slabYMin * resolution;
  const xMax = xOrigin + slabWidth * (slabXMax + 1) * resolution;
  const yMax = yOrigin - slabHeight * (slabYMax + 1) * resolution;

  // création de la gemetrie
  const geomPolygon = {
    type: 'Polygon',
    coordinates: [[
      [xMin, yMin],
      [xMin, yMax],
      [xMax, yMax],
      [xMax, yMin],
      [xMin, yMin],
    ]],
  };
  debug(`feature n°${feature.properties.id} création d'une geometrie Polygon`);
  debug(feature.geomPolygon);
  debug(xMin, yMin, xMax, yMax);
  return { ...feature, geomPolygon };
}

async function merge(req, res, next) {
  debug('~~~merge branch~~~');
  if (req.error) {
    await pgClient.close(req, res, () => {});
    next();
    return;
  }
  const params = matchedData(req);
  const { idBranch, name } = params;
  debug(idBranch, name);
  // On récupère est on enléve la premier valeur du tableau d'ids des branches
  const idBase = idBranch.shift();
  let idNewBranch;
  let newMergePatches;

  // Vérification que les branches sont sur le même cache
  const cache = await db.getCache(req.client, idBase);
  const branchesCache = await db.getBranches(req.client, cache.id);
  const idBranchesCache = branchesCache.map((branch) => branch.id);
  const idsMiss = idBranch.find((id) => !idBranchesCache.includes(id));
  if (idsMiss) {
    req.error = {
      msg: `Branch '${idsMiss}' is not part of the cache ${cache.id}`,
      code: 406,
      function: 'merge',
    };
    await pgClient.close(req, res, () => {});
    next();
    return;
  }

  // On commence par creer une copie de la branche
  // avec le bon nom et un nouvel id
  try {
    [idNewBranch, newMergePatches] = await initMergeBranch(req.client, name, idBase,
      cache, req.overviews);
    debug('newMergePatches : ', newMergePatches);
  } catch (error) {
    debug(error);
    req.error = {
      msg: `Branch '${idBase}' merge failed with error: ${error.message}`,
      code: 406,
      function: 'merge',
    };
    await pgClient.close(req, res, () => {});
    next();
    return;
  }

  // Comme cela peut-être long
  // il faut créer un processus
  const idProcess = await db.createProcess(req.client,
    `base: ${idBase} + branch: ${idBranch} -> ${idNewBranch} (${name})`);
  // on retourne l'identifiant de la branche, son nom et l'identifiant et du processus
  req.result = { json: { idNewBranch, idProcess }, code: 200 };
  next();
  // on applique les patchs des autres Branches dans cette nouvelle branche
  debug(`Boucle sur les ids Banches ${idBranch}`);
  const buffer = NBPX * req.overviews.resolution;
  const intersectMerge = {
    type: 'FeatureCollection',
    features: [],
  };
  const nbBranch = idBranch.length;
  try {
    for (const [i, idBr] of idBranch.entries()) {
      // On fait un commit pour la première partie du merge et on ouvre une transaction
      // pour chaque traitement de branche
      await db.endTransaction(req.client, !(req.error));
      await db.beginTransaction(req.client);
      // Traitement d'une branche
      const patches = await db.getActivePatches(req.client, idBr);
      patches.features.sort((el1, el2) => el1.properties.id - el2.properties.id);
      debug('>>applyPatches', patches.features);
      // Clonage du patches pour en modifier un
      const patchWithOneFeature = JSON.parse(JSON.stringify(patches));
      for (let feature of patches.features) {
        // Vérification si la saisie intersect une autre saisie de la branche de merge
        for (let featureBase of newMergePatches.features) {
          // TODO: récupération de la gémetrie polygone des features données
          // comment faire pour les semi-auto?
          // à partir des slabs on prend leurs coordonnées max et min pour faire un polygone
          // il faudrait stocker ce résultat pour ne pas à avoir à le recalculer à chaque fois
          feature = getGeometryFeature(feature, req.overviews);
          featureBase = getGeometryFeature(featureBase, req.overviews);
          const intersection = gdalProcessing.geometriesIntersection(feature.geomPolygon,
            featureBase.geomPolygon, buffer, req.overviews.crs.code);
          if (intersection && !intersection.isEmpty()) {
            const centroid = intersection.centroid();
            let ms = `feature id ${feature.properties.id} intersect `;
            ms += `feature id ${featureBase.properties.id}`;
            ms += `Le barycentre de l'intersection est ${centroid.x}, ${centroid.y}.`;
            debug(ms);
            intersectMerge.features.push({
              type: 'Feature',
              geometry: centroid.toObject(),
              properties: {
                idPatch: feature.properties.id,
                idBranch: feature.properties.id_branch,
                idPatchBase: featureBase.properties.id,
                idBranchBase: featureBase.properties.id_branch,
              },
            });
          }
        }
        // Application du patch
        patchWithOneFeature.features = [feature];
        await patch.applyPatch(
          req.client,
          req.overviews,
          cache.path,
          idNewBranch,
          patchWithOneFeature,
        );
      }
      debug('fin de applyPatches');
      // Ajout patches appliqués aux patches de la branche
      newMergePatches.features = newMergePatches.features.concat(patches.features);
      await db.updateProcess(req.client, idProcess, `${((i + 1) / nbBranch) * 100}%`);
    }
    await db.finishProcess(req.client, 'succeed', idProcess, 'done');
  } catch (error) {
    debug(error);
    await db.finishProcess(req.client, 'failed', idProcess, 'done');
  }
  if (intersectMerge.features.length !== 0) {
    const dir = `${cache.path}/alertes_merge`;
    try {
      fs.mkdirSync(dir);
    } catch (error) {
      if (error.code !== 'EEXIST') debug(error);
    }
    fs.writeFileSync(`${dir}/${NOM_VECT_INTER_MERGE}_${idNewBranch}.geojson`,
      JSON.stringify(intersectMerge));
  }
  pgClient.close(req, res, () => {});
}

async function getCachePath(req, _res, next) {
  debug('>>GET CachePath');
  if (req.error) {
    next();
    return;
  }
  const params = matchedData(req);
  let { idBranch } = params;
  if (Array.isArray(idBranch)) {
    [idBranch] = idBranch;
  }
  try {
    req.dir_cache = await db.getCachePath(req.client, idBranch);
  } catch (error) {
    debug(error);
    req.error = error;
  }
  debug('  next>>');
  next();
}

module.exports = {
  getBranches,
  postBranch,
  deleteBranch,
  merge,
  getCachePath,
};
