const debug = require('debug')('gjson');
const fs = require('fs');

async function writeGeojson(idBranch, idPatch, cachePath, geojson) {
  debug(' ~~writeGeojson');
  // create dir if it does not exist
  const dir = `${cachePath}/tmp_test_js`;
  try {
    return fs.mkdirSync(dir);
  } catch (error) {
    if (error.code !== 'EEXIST') debug(error);
  }

  // write patch geojson
  const filePath = `${dir}/patch_idBr${idBranch}_idP${idPatch}.geojson`;

  const geojsonAna = JSON.parse(JSON.stringify(geojson));

  geojsonAna.name = `${idBranch}_${idPatch}`;

  const prop = geojson.features[0].properties;
  if (prop.opiSec.name) {
    geojsonAna.features[0].geometry.type = 'MultiLineString';
  }
  geojsonAna.features[0].geometry.coordinates = [geojsonAna.features[0].geometry.coordinates];

  geojsonAna.features[0].properties = {
    opiName: prop.opiRef.name,
    color: prop.opiRef.color,
    opiName2: prop.opiSec.name,
    colorSec: prop.opiSec.color,
  };

  try {
    fs.writeFileSync(filePath, JSON.stringify(geojsonAna, null, 2), 'utf8');
    debug(`  File '${filePath}' written`);
  } catch (error) {
    debug(error);
  }
  return filePath;
}

module.exports = {
  writeGeojson,
};
