 /*
 * @author mbredif / http://github.com/mbredif
 */
import * as THREE from "three";
import { NetCDFReader } from "netcdfjs";
import { VolumeRenderShaderSampling as SamplingShader } from '../js/VolumeShader';
import { VolumeRenderShaderIntegrating as IntegratingShader } from '../js/VolumeShader';

function instanceNetcdfReader(arrayBuffer) {
	return new NetCDFReader(arrayBuffer);
}

function getValue(view, offset, type) {
	switch (type) {
	case 'byte' : return i => view.getInt8(offset + i, false);
	// case 'char' : // not supported
	case 'short' : return i => view.getInt16(offset + i*2, false);
	case 'int' : return i => view.getInt32(offset + i*4, false);
	case 'float' : return i => view.getFloat32(offset + i*4, false);
	case 'double' : return i => view.getFloat64(offset + i*8, false);
	default : console.error('unsupported type : ',type); return i => 0
	}
}

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
			const header = new NetCDFReader(buffer);
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

function getGLtype(type) {
	switch (type) {
	case 'byte' : return THREE.UnsignedByteType;
	// case 'char' : // not supported
	case 'short' : return THREE.FloatType;
	case 'int' : return THREE.FloatType;
	case 'float' : return THREE.FloatType;
	case 'double' : return THREE.FloatType; // no double format
	default : console.error('unsupported type : ',type); return undefined;
	}
}

function getTypedArray(volume) {
	switch (volume.type) {
	case 'byte' : return new Uint8Array(volume.size);
	// case 'char' : // not supported
	case 'short' : return new Float32Array(volume.size);
	case 'int' : return new Float32Array(volume.size);
	case 'float' : return new Float32Array(volume.size);
	case 'double' : return new Float32Array(volume.size); // no double format
	default : console.error('unsupported type : ',volume.type); return i => 0
	}
}

function decodeVolume(buffer, volume, offset = 0) {
	const view = new DataView(buffer);
	const getVal = getValue(view, offset, volume.type);
	volume.data = getTypedArray(volume);
	volume.min = Infinity;
	volume.max =-Infinity;
	
	if(volume.record) {
		console.warn('decoding of record data is not fully supported yet', volume.record);
	}
	
	for(var i = 0; i<volume.size; i++) {
		const v = getVal(i);
		volume.data[i] = v;
		if(volume.min > v) volume.min = v;
		if(volume.max < v) volume.max = v;
	}
	console.log(volume);
	return volume;
}

function getDimension(header, variable, i) {
	if (i>=variable.dimensions.length) return 1;
	const dim = variable.dimensions[i];
	const rec = header.recordDimension;
	return (dim == rec.id) ? rec.length : header.dimensions[dim].size;
}

function fetchVolume(header, variableName, forceRangeRequest = false) {
	if (header.bytesReceived === undefined) header.bytesReceived = header.buffer.byteLength;
	const rangeRequest = forceRangeRequest || header.acceptRanges;
	var variable = header.variables.find(val => val.name === variableName);
	var volume = {
		'variable': variableName,
		'xLength': getDimension(header,variable,0),
		'yLength': getDimension(header,variable,1),
		'zLength': getDimension(header,variable,2),
		'type' : variable.type,
	};
	if (variable.record) volume.record = header.recordDimension;
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
		return Promise.resolve(decodeVolume(header.buffer.buffer, volume, first));

	// Data is missing, get it using a range request
	const headers = new Headers({ Range: `bytes=${first}-${last}` });
	return fetch(header.url, { headers })
	.then(response => response.arrayBuffer())
	.then(buffer => decodeVolume(buffer, volume));
}

function normalizeVolume(volume) {
	if (getGLtype(volume.type) != THREE.FloatType) return volume;
	for(var i = 0; i<volume.size; i++)
		volume.data[i] = Math.min(1,Math.max(0,(volume.data[i]-volume.min)/(volume.max-volume.min)));
	return volume;

}

function createTexture(volume) {

	var texture = new THREE.Data3DTexture( volume.data, volume.zLength, volume.yLength, volume.xLength );
	texture.format = THREE.RedFormat;
	texture.type = getGLtype(volume.type);
	texture.minFilter = texture.magFilter = THREE.LinearFilter;
	texture.unpackAlignment = 1;
	texture.name = volume.variable;
	texture.needsUpdate = true;
	return texture;

}

function createMesh(config, texture) {
	
	var geometry = new THREE.BoxGeometry();

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
		const STEP_SIZE = 0.5; // should be < 1, lower gets better quality but worse performance
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

export default { instanceNetcdfReader, readNetcdfHeader, fetchVolume, normalizeVolume, createTexture, createMesh, createSamplingMaterial };
