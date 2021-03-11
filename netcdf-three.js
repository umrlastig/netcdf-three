 /*
 * @author mbredif / http://github.com/mbredif
 */

import * as THREE from "./js/three.js";
import { VolumeRenderShaderSampling as SamplingShader } from './js/VolumeShader.js';
import { VolumeRenderShaderIntegrating as IntegratingShader } from './js/VolumeShader.js';

function readNetcdfHeader(response) { 
	var reader = response.body.getReader();
	var bytesReceived = 0;
	var buffer = null;
	return reader.read().then(function process(result) {
		// append new bytes to the buffer
		var received = bytesReceived + result.value.length;
		if(!buffer) {
			buffer = result.value;
		} else {
			var old = buffer.subarray(0, bytesReceived);
			buffer = new Uint8Array(received);
			buffer.set(old, 0, bytesReceived);
			buffer.set(result.value, bytesReceived);
		}
		bytesReceived = received;

		// try reading the header
		try {
			const header = new netcdfjs(buffer);
			header.url = response.url;
			header.reader = reader;
			header.bytesTotal = response.headers.get("Content-Length");
			header.acceptRanges = response.headers.get("Accept-Ranges") === 'bytes';
			header.bytesReceived = bytesReceived;
			return header;

		} catch (e) {
			// end is reached with no decodable header
			if (result.done) {
				console.log('eof, no valid netcdf header!');
				return;
			}
			// keep reading
			return reader.read().then(process);
		}
	});
}

function decodeVolume(buffer, volume, offset = 0) {
	volume.data = new Float32Array(volume.size);
	var view = new DataView(buffer);
	for(var i = 0; i<volume.size; i++)
		volume.data[i] = view.getFloat64(offset + i*8, false);
	volume.min = Math.min.apply(null, volume.data.filter(x => x>1));
	volume.max = Math.max.apply(null, volume.data);
	console.log(volume);
	return volume;
}

function fetchVolume(header, variableName, forceRangeRequest = false) {
	const rangeRequest = forceRangeRequest || header.acceptRanges;
	var variable = header.variables.find(val => val.name === variableName);
	var volume = {
		'variable': variableName,
		'xLength': header.dimensions[variable.dimensions[0]].size,
		'yLength': header.dimensions[variable.dimensions[1]].size,
		'zLength': header.dimensions[variable.dimensions[2]].size
	};
	volume.size = volume.xLength * volume.yLength * volume.zLength;
	const first = variable.offset;
	const last = first + variable.size - 1;

	// Data is missing and ranges are not accepted
	if (!rangeRequest && last >= header.bytesReceived)
	{
		// TODO, use reader if present
		if (header.reader) {
			// TODO, use reader if present
		}

		// TODO, stop if enough bytes are read
		return fetch(header.url)
		.then(response => response.arrayBuffer())
		.then(buffer => decodeVolume(buffer, volume, first));
	}

	if (header.reader) { header.reader.cancel(); header.reader = undefined; }

	if (last < header.bytesReceived)
		return decodeVolume(header.buffer.buffer, volume, first);
	
	// Data is missing, get it using a range request
	const headers = new Headers({ Range: `bytes=${first}-${last}` });
	return fetch(header.url, { headers })
	.then(response => response.arrayBuffer())
	.then(buffer => decodeVolume(buffer, volume));
}

function normalizeVolume(volume) {

	for(var i = 0; i<volume.size; i++)
		volume.data[i] = Math.min(1,Math.max(0,(volume.data[i]-volume.min)/(volume.max-volume.min)));
	return volume;

}

function createTexture(volume) {

	var texture = new THREE.DataTexture3D( volume.data, volume.zLength, volume.yLength, volume.xLength );
	texture.format = THREE.RedFormat;
	texture.type = THREE.FloatType;
	texture.minFilter = texture.magFilter = THREE.LinearFilter;
	texture.unpackAlignment = 1;
	return texture;
	
}

function createMesh(config, texture) {
	
	var geometry = new THREE.BoxBufferGeometry();

	var uniforms = THREE.UniformsUtils.clone( IntegratingShader.uniforms );
	var material = new THREE.ShaderMaterial( {
		uniforms: uniforms,
		vertexShader: IntegratingShader.vertexShader,
		fragmentShader: IntegratingShader.fragmentShader,
		side: THREE.BackSide // The volume shader uses the backface as its "reference point"
	} );
	material.extensions.fragDepth = true;

	var mesh = new THREE.Mesh( geometry, material );
	mesh.updateConfig = function(config) {
		this.material.uniforms[ "u_clim" ].value.set( config.clim1, config.clim2 );
		this.material.uniforms[ "u_renderstyle" ].value = config.renderstyle == 'mip' ? 0 : 1; // 0: MIP, 1: ISO
		this.material.uniforms[ "u_cmdata" ].value = config.cm;
		
		// ISO renderstyle uniforms
		this.material.uniforms[ "u_iso_threshold" ].value = config.iso_threshold;
		this.material.uniforms[ "u_iso_ambient_color" ].value.set(config.iso_ambient_color);
		this.material.uniforms[ "u_iso_diffuse_color" ].value.set(config.iso_diffuse_color);
		this.material.uniforms[ "u_iso_specular_color" ].value.set(config.iso_specular_color);
		this.material.uniforms[ "u_iso_shininess" ].value = config.iso_shininess;

	}
	mesh.updateTexture = function(texture) {
		const x = texture ? texture.image.width : 1;
		const y = texture ? texture.image.height : 1;
		const z = texture ? texture.image.depth : 1;
		this.position.set( x / 2, y / 2, z / 2 );
		this.scale.set(x,y,z);
		this.updateMatrixWorld();
		this.material.uniforms[ "u_data" ].value = texture;
		this.material.uniforms[ "u_size" ].value.set( x, y, z );
		const STEP_SIZE = 0.5; // should be < 1, lower gets better quality but worst performance
		this.material.defines["STEP_SIZE"] = STEP_SIZE;
		this.material.defines["MAX_STEPS"] = Math.ceil(Math.sqrt(x*x+y*y+z*z)/STEP_SIZE);
		this.material.defines["REFINEMENT_STEPS"] = 10;
		this.material.needsUpdate = true;
	}
	mesh.updateConfig(config);
	mesh.updateTexture(texture);
	return mesh;

}

function createSamplingMaterial(config, texture) {
	
	var planeUniforms = THREE.UniformsUtils.clone( SamplingShader.uniforms );
	var material = new THREE.ShaderMaterial( {
		side: THREE.DoubleSide,
		uniforms: planeUniforms,
		vertexShader: SamplingShader.vertexShader,
		fragmentShader: SamplingShader.fragmentShader
	} );
	material.updateTexture = function(texture) {
		const size = texture ? [texture.image.width, texture.image.height, texture.image.depth] : [0,0,0];
		this.uniforms[ "u_data" ].value = texture;
		this.uniforms[ "u_size" ].value.set( size[0], size[1], size[2] );
	}
	material.updateConfig = function(config) {
		this.uniforms[ "u_clim" ].value.set( config.clim1, config.clim2 );
		this.uniforms[ "u_cmdata" ].value = config.cm;
	}
	material.updateTexture(texture);
	material.updateConfig(config);
	return material;

}

export { readNetcdfHeader, fetchVolume, normalizeVolume, createTexture, createMesh, createSamplingMaterial };