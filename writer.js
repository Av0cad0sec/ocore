/*jslint node: true */
"use strict";
var _ = require('lodash');
var async = require('async');
var constants = require("./constants.js");
var conf = require("./conf.js");
var storage = require('./storage.js');
var db = require('./db.js');
var objectHash = require("./object_hash.js");
var mutex = require('./mutex.js');
var main_chain = require("./main_chain.js");
var Definition = require("./definition.js");
var eventBus = require('./event_bus.js');
var profiler = require('./profiler.js');
var breadcrumbs = require('./breadcrumbs.js');
var kvstore = require('./kvstore.js');

var testnetAAsDefinedByAAsAreActiveImmediatelyUpgradeMci = 1167000;

var bCordova = (typeof window === 'object' && window.cordova);

var count_writes = 0;
var count_units_in_prev_analyze = 0;

function saveJoint(objJoint, objValidationState, preCommitCallback, onDone) {
	var objUnit = objJoint.unit;
	console.log("\nsaving unit "+objUnit.unit);
	profiler.start();
	var arrQueries = [];
	var commit_fn;
	if (objValidationState.conn && !objValidationState.batch)
		throw Error("conn but not batch");
	var bInLargerTx = (objValidationState.conn && objValidationState.batch);

	function initConnection(handleConnection) {
		if (bInLargerTx) {
			commit_fn = function (sql, cb) { cb(); };
			return handleConnection(objValidationState.conn);
		}
		db.takeConnectionFromPool(function (conn) {
			conn.addQuery(arrQueries, "BEGIN");
			commit_fn = function (sql, cb) {
				conn.query(sql, function () {
					cb();
				});
			};
			handleConnection(conn);
		});
	}
	
	initConnection(function(conn){
		var start_time = Date.now();
		
		// additional queries generated by the validator, used only when received a doublespend
		for (var i=0; i<objValidationState.arrAdditionalQueries.length; i++){
			var objAdditionalQuery = objValidationState.arrAdditionalQueries[i];
			conn.addQuery(arrQueries, objAdditionalQuery.sql, objAdditionalQuery.params);
			breadcrumbs.add('====== additional query '+JSON.stringify(objAdditionalQuery));
			if (objAdditionalQuery.sql.match(/temp-bad/)){
				var arrUnstableConflictingUnits = objAdditionalQuery.params[0];
				breadcrumbs.add('====== conflicting units in additional queries '+arrUnstableConflictingUnits.join(', '));
				arrUnstableConflictingUnits.forEach(function(conflicting_unit){
					var objConflictingUnitProps = storage.assocUnstableUnits[conflicting_unit];
					if (!objConflictingUnitProps)
						return breadcrumbs.add("====== conflicting unit "+conflicting_unit+" not found in unstable cache"); // already removed as uncovered
					if (objConflictingUnitProps.sequence === 'good')
						objConflictingUnitProps.sequence = 'temp-bad';
				});
			}
		}
		
		if (bCordova)
			conn.addQuery(arrQueries, "INSERT INTO joints (unit, json) VALUES (?,?)", [objUnit.unit, JSON.stringify(objJoint)]);

		var timestamp = (objUnit.version === constants.versionWithoutTimestamp) ? 0 : objUnit.timestamp;
		var fields = "unit, version, alt, witness_list_unit, last_ball_unit, headers_commission, payload_commission, sequence, content_hash, timestamp";
		var values = "?,?,?,?,?,?,?,?,?,?";
		var params = [objUnit.unit, objUnit.version, objUnit.alt, objUnit.witness_list_unit, objUnit.last_ball_unit,
			objUnit.headers_commission || 0, objUnit.payload_commission || 0, objValidationState.sequence, objUnit.content_hash,
			timestamp];
		if (conf.bLight){
			fields += ", main_chain_index, creation_date";
			values += ",?,"+conn.getFromUnixTime("?");
			params.push(objUnit.main_chain_index, objUnit.timestamp);
		}
		if (conf.bFaster){
			my_best_parent_unit = objValidationState.best_parent_unit;
			fields += ", best_parent_unit, witnessed_level";
			values += ",?,?";
			params.push(objValidationState.best_parent_unit, objValidationState.witnessed_level);
		}
		var ignore = (objValidationState.sequence === 'final-bad') ? conn.getIgnore() : ''; // possible re-insertion of a previously stripped unit
		conn.addQuery(arrQueries, "INSERT " + ignore + " INTO units ("+fields+") VALUES ("+values+")", params);
		
		if (objJoint.ball && !conf.bLight){
			conn.addQuery(arrQueries, "INSERT INTO balls (ball, unit) VALUES(?,?)", [objJoint.ball, objUnit.unit]);
			conn.addQuery(arrQueries, "DELETE FROM hash_tree_balls WHERE ball=? AND unit=?", [objJoint.ball, objUnit.unit]);
			delete storage.assocHashTreeUnitsByBall[objJoint.ball];
			if (objJoint.skiplist_units)
				for (var i=0; i<objJoint.skiplist_units.length; i++)
					conn.addQuery(arrQueries, "INSERT INTO skiplist_units (unit, skiplist_unit) VALUES (?,?)", [objUnit.unit, objJoint.skiplist_units[i]]);
		}
		
		if (objUnit.parent_units){
			for (var i=0; i<objUnit.parent_units.length; i++)
				conn.addQuery(arrQueries, "INSERT INTO parenthoods (child_unit, parent_unit) VALUES(?,?)", [objUnit.unit, objUnit.parent_units[i]]);
		}
		
		var bGenesis = storage.isGenesisUnit(objUnit.unit);
		if (bGenesis)
			conn.addQuery(arrQueries, 
				"UPDATE units SET is_on_main_chain=1, main_chain_index=0, is_stable=1, level=0, witnessed_level=0 \n\
				WHERE unit=?", [objUnit.unit]);
		else {
			conn.addQuery(arrQueries, "UPDATE units SET is_free=0 WHERE unit IN(?)", [objUnit.parent_units], function(result){
				// in sqlite3, result.affectedRows actually returns the number of _matched_ rows
				var count_consumed_free_units = result.affectedRows;
				console.log(count_consumed_free_units+" free units consumed");
				objUnit.parent_units.forEach(function(parent_unit){
					if (storage.assocUnstableUnits[parent_unit])
						storage.assocUnstableUnits[parent_unit].is_free = 0;
				})
			});
		}
		
		if (Array.isArray(objUnit.witnesses)){
			for (var i=0; i<objUnit.witnesses.length; i++){
				var address = objUnit.witnesses[i];
				conn.addQuery(arrQueries, "INSERT INTO unit_witnesses (unit, address) VALUES(?,?)", [objUnit.unit, address]);
			}
			conn.addQuery(arrQueries, "INSERT "+conn.getIgnore()+" INTO witness_list_hashes (witness_list_unit, witness_list_hash) VALUES (?,?)", 
				[objUnit.unit, objectHash.getBase64Hash(objUnit.witnesses)]);
		}
		
		var arrAuthorAddresses = [];
		for (var i=0; i<objUnit.authors.length; i++){
			var author = objUnit.authors[i];
			arrAuthorAddresses.push(author.address);
			var definition = author.definition;
			var definition_chash = null;
			if (definition){
				// IGNORE for messages out of sequence
				definition_chash = objectHash.getChash160(definition);
				conn.addQuery(arrQueries, "INSERT "+conn.getIgnore()+" INTO definitions (definition_chash, definition, has_references) VALUES (?,?,?)", 
					[definition_chash, JSON.stringify(definition), Definition.hasReferences(definition) ? 1 : 0]);
				// actually inserts only when the address is first used.
				// if we change keys and later send a unit signed by new keys, the address is not inserted. 
				// Its definition_chash was updated before when we posted change-definition message.
				if (definition_chash === author.address)
					conn.addQuery(arrQueries, "INSERT "+conn.getIgnore()+" INTO addresses (address) VALUES(?)", [author.address]);
			}
			else if (objUnit.content_hash)
				conn.addQuery(arrQueries, "INSERT "+conn.getIgnore()+" INTO addresses (address) VALUES(?)", [author.address]);
			conn.addQuery(arrQueries, "INSERT INTO unit_authors (unit, address, definition_chash) VALUES(?,?,?)", 
				[objUnit.unit, author.address, definition_chash]);
			if (bGenesis)
				conn.addQuery(arrQueries, "UPDATE unit_authors SET _mci=0 WHERE unit=?", [objUnit.unit]);
		/*	if (!objUnit.content_hash){
				for (var path in author.authentifiers)
					conn.addQuery(arrQueries, "INSERT INTO authentifiers (unit, address, path, authentifier) VALUES(?,?,?,?)", 
						[objUnit.unit, author.address, path, author.authentifiers[path]]);
			}*/
		}
		
		if (!objUnit.content_hash){
			for (var i=0; i<objUnit.messages.length; i++){
				var message = objUnit.messages[i];
				
				var text_payload = null;
				if (message.app === "text")
					text_payload = message.payload;
				else if (message.app === "data" || message.app === "profile" || message.app === "attestation" || message.app === "definition_template")
					text_payload = JSON.stringify(message.payload);
				
				conn.addQuery(arrQueries, "INSERT INTO messages \n\
					(unit, message_index, app, payload_hash, payload_location, payload, payload_uri, payload_uri_hash) VALUES(?,?,?,?,?,?,?,?)", 
					[objUnit.unit, i, message.app, message.payload_hash, message.payload_location, text_payload, 
					message.payload_uri, message.payload_uri_hash]);
				
				if (message.payload_location === "inline"){
					switch (message.app){
						case "address_definition_change":
							var definition_chash = message.payload.definition_chash;
							var address = message.payload.address || objUnit.authors[0].address;
							conn.addQuery(arrQueries, 
								"INSERT INTO address_definition_changes (unit, message_index, address, definition_chash) VALUES(?,?,?,?)", 
								[objUnit.unit, i, address, definition_chash]);
							break;
						case "poll":
							var poll = message.payload;
							conn.addQuery(arrQueries, "INSERT INTO polls (unit, message_index, question) VALUES(?,?,?)", [objUnit.unit, i, poll.question]);
							for (var j=0; j<poll.choices.length; j++)
								conn.addQuery(arrQueries, "INSERT INTO poll_choices (unit, choice_index, choice) VALUES(?,?,?)", 
									[objUnit.unit, j, poll.choices[j]]);
							break;
						case "vote":
							var vote = message.payload;
							conn.addQuery(arrQueries, "INSERT INTO votes (unit, message_index, poll_unit, choice) VALUES (?,?,?,?)", 
								[objUnit.unit, i, vote.unit, vote.choice]);
							break;
						case "attestation":
							var attestation = message.payload;
							conn.addQuery(arrQueries, "INSERT INTO attestations (unit, message_index, attestor_address, address) VALUES(?,?,?,?)", 
								[objUnit.unit, i, objUnit.authors[0].address, attestation.address]);
							for (var field in attestation.profile){
								var value = attestation.profile[field];
								if (field == field.trim() && field.length <= constants.MAX_PROFILE_FIELD_LENGTH
										&& typeof value === 'string' && value == value.trim() && value.length <= constants.MAX_PROFILE_VALUE_LENGTH)
									conn.addQuery(arrQueries, 
										"INSERT INTO attested_fields (unit, message_index, attestor_address, address, field, value) VALUES(?,?, ?,?, ?,?)",
										[objUnit.unit, i, objUnit.authors[0].address, attestation.address, field, value]);
							}
							break;
						case "asset":
							var asset = message.payload;
							conn.addQuery(arrQueries, "INSERT INTO assets (unit, message_index, \n\
								cap, is_private, is_transferrable, auto_destroy, fixed_denominations, \n\
								issued_by_definer_only, cosigned_by_definer, spender_attested, \n\
								issue_condition, transfer_condition) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", 
								[objUnit.unit, i, 
								asset.cap, asset.is_private?1:0, asset.is_transferrable?1:0, asset.auto_destroy?1:0, asset.fixed_denominations?1:0, 
								asset.issued_by_definer_only?1:0, asset.cosigned_by_definer?1:0, asset.spender_attested?1:0, 
								asset.issue_condition ? JSON.stringify(asset.issue_condition) : null,
								asset.transfer_condition ? JSON.stringify(asset.transfer_condition) : null]);
							if (asset.attestors){
								for (var j=0; j<asset.attestors.length; j++){
									conn.addQuery(arrQueries, 
										"INSERT INTO asset_attestors (unit, message_index, asset, attestor_address) VALUES(?,?,?,?)",
										[objUnit.unit, i, objUnit.unit, asset.attestors[j]]);
								}
							}
							if (asset.denominations){
								for (var j=0; j<asset.denominations.length; j++){
									conn.addQuery(arrQueries, 
										"INSERT INTO asset_denominations (asset, denomination, count_coins) VALUES(?,?,?)",
										[objUnit.unit, asset.denominations[j].denomination, asset.denominations[j].count_coins]);
								}
							}
							break;
						case "asset_attestors":
							var asset_attestors = message.payload;
							for (var j=0; j<asset_attestors.attestors.length; j++){
								conn.addQuery(arrQueries, 
									"INSERT INTO asset_attestors (unit, message_index, asset, attestor_address) VALUES(?,?,?,?)",
									[objUnit.unit, i, asset_attestors.asset, asset_attestors.attestors[j]]);
							}
							break;
					/*	case "data_feed":
							var data = message.payload;
							var arrValues = [];
							for (var feed_name in data){
								var value = data[feed_name];
								var sql_value = 'NULL';
								var sql_int_value = 'NULL';
								if (typeof value === 'string')
									sql_value = db.escape(value);
								else
									sql_int_value = value;
								arrValues.push("("+db.escape(objUnit.unit)+", "+i+", "+db.escape(feed_name)+", "+sql_value+", "+sql_int_value+")");
							//	var field_name = (typeof value === 'string') ? "`value`" : "int_value";
							//	conn.addQuery(arrQueries, "INSERT INTO data_feeds (unit, message_index, feed_name, "+field_name+") VALUES(?,?,?,?)", 
							//		[objUnit.unit, i, feed_name, value]);
							}
							conn.addQuery(arrQueries, 
								"INSERT INTO data_feeds (unit, message_index, feed_name, `value`, int_value) VALUES "+arrValues.join(', '));
							break;*/
							
						case "payment":
							// we'll add inputs/outputs later because we need to read the payer address
							// from src outputs, and it's inconvenient to read it synchronously
							break;
					} // switch message.app
				} // inline

				if ("spend_proofs" in message){
					for (var j=0; j<message.spend_proofs.length; j++){
						var objSpendProof = message.spend_proofs[j];
						conn.addQuery(arrQueries, 
							"INSERT INTO spend_proofs (unit, message_index, spend_proof_index, spend_proof, address) VALUES(?,?,?,?,?)", 
							[objUnit.unit, i, j, objSpendProof.spend_proof, objSpendProof.address || arrAuthorAddresses[0] ]);
					}
				}
			}
		}

		if ("earned_headers_commission_recipients" in objUnit){
			for (var i=0; i<objUnit.earned_headers_commission_recipients.length; i++){
				var recipient = objUnit.earned_headers_commission_recipients[i];
				conn.addQuery(arrQueries, 
					"INSERT INTO earned_headers_commission_recipients (unit, address, earned_headers_commission_share) VALUES(?,?,?)", 
					[objUnit.unit, recipient.address, recipient.earned_headers_commission_share]);
			}
		}

		var my_best_parent_unit = objValidationState.best_parent_unit;
		
		function determineInputAddressFromSrcOutput(asset, denomination, input, handleAddress){
			conn.query(
				"SELECT address, denomination, asset FROM outputs WHERE unit=? AND message_index=? AND output_index=?",
				[input.unit, input.message_index, input.output_index],
				function(rows){
					if (rows.length > 1)
						throw Error("multiple src outputs found");
					if (rows.length === 0){
						if (conf.bLight) // it's normal that a light client doesn't store the previous output
							return handleAddress(null);
						else
							throw Error("src output not found");
					}
					var row = rows[0];
					if (!(!asset && !row.asset || asset === row.asset))
						throw Error("asset doesn't match");
					if (denomination !== row.denomination)
						throw Error("denomination doesn't match");
					var address = row.address;
					if (arrAuthorAddresses.indexOf(address) === -1)
						throw Error("src output address not among authors");
					handleAddress(address);
				}
			);
		}
		
		function addInlinePaymentQueries(cb){
			async.forEachOfSeries(
				objUnit.messages,
				function(message, i, cb2){
					if (message.payload_location !== 'inline')
						return cb2();
					var payload = message.payload;
					if (message.app !== 'payment')
						return cb2();
					
					var denomination = payload.denomination || 1;
					
					async.forEachOfSeries(
						payload.inputs,
						function(input, j, cb3){
							var type = input.type || "transfer";
							var src_unit = (type === "transfer") ? input.unit : null;
							var src_message_index = (type === "transfer") ? input.message_index : null;
							var src_output_index = (type === "transfer") ? input.output_index : null;
							var from_main_chain_index = (type === "witnessing" || type === "headers_commission") ? input.from_main_chain_index : null;
							var to_main_chain_index = (type === "witnessing" || type === "headers_commission") ? input.to_main_chain_index : null;
							
							var determineInputAddress = function(handleAddress){
								if (type === "headers_commission" || type === "witnessing" || type === "issue")
									return handleAddress((arrAuthorAddresses.length === 1) ? arrAuthorAddresses[0] : input.address);
								// hereafter, transfer
								if (arrAuthorAddresses.length === 1)
									return handleAddress(arrAuthorAddresses[0]);
								determineInputAddressFromSrcOutput(payload.asset, denomination, input, handleAddress);
							};
							
							determineInputAddress(function(address){
								var is_unique = 
									(objValidationState.arrDoubleSpendInputs.some(function(ds){ return (ds.message_index === i && ds.input_index === j); }) || conf.bLight) 
									? null : 1;
								conn.addQuery(arrQueries, "INSERT INTO inputs \n\
										(unit, message_index, input_index, type, \n\
										src_unit, src_message_index, src_output_index, \
										from_main_chain_index, to_main_chain_index, \n\
										denomination, amount, serial_number, \n\
										asset, is_unique, address) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
									[objUnit.unit, i, j, type, 
									 src_unit, src_message_index, src_output_index, 
									 from_main_chain_index, to_main_chain_index, 
									 denomination, input.amount, input.serial_number, 
									 payload.asset, is_unique, address]);
								switch (type){
									case "transfer":
										conn.addQuery(arrQueries, 
											"UPDATE outputs SET is_spent=1 WHERE unit=? AND message_index=? AND output_index=?",
											[src_unit, src_message_index, src_output_index]);
										break;
									case "headers_commission":
									case "witnessing":
										var table = type + "_outputs";
										conn.addQuery(arrQueries, "UPDATE "+table+" SET is_spent=1 \n\
											WHERE main_chain_index>=? AND main_chain_index<=? AND address=?", 
											[from_main_chain_index, to_main_chain_index, address]);
										break;
								}
								cb3();
							});
						},
						function(){
							for (var j=0; j<payload.outputs.length; j++){
								var output = payload.outputs[j];
								// we set is_serial=1 for public payments as we check that their inputs are stable and serial before spending, 
								// therefore it is impossible to have a nonserial in the middle of the chain (but possible for private payments)
								conn.addQuery(arrQueries, 
									"INSERT INTO outputs \n\
									(unit, message_index, output_index, address, amount, asset, denomination, is_serial) VALUES(?,?,?,?,?,?,?,1)",
									[objUnit.unit, i, j, output.address, parseInt(output.amount), payload.asset, denomination]
								);
							}
							cb2();
						}
					);
				},
				cb
			);
		}
				
		function updateBestParent(cb){
			// choose best parent among compatible parents only
			conn.query(
				"SELECT unit \n\
				FROM units AS parent_units \n\
				WHERE unit IN(?) \n\
					AND (witness_list_unit=? OR ( \n\
						SELECT COUNT(*) \n\
						FROM unit_witnesses \n\
						JOIN unit_witnesses AS parent_witnesses USING(address) \n\
						WHERE parent_witnesses.unit IN(parent_units.unit, parent_units.witness_list_unit) \n\
							AND unit_witnesses.unit IN(?, ?) \n\
					)>=?) \n\
				ORDER BY witnessed_level DESC, \n\
					level-witnessed_level ASC, \n\
					unit ASC \n\
				LIMIT 1", 
				[objUnit.parent_units, objUnit.witness_list_unit, 
				objUnit.unit, objUnit.witness_list_unit, constants.COUNT_WITNESSES - constants.MAX_WITNESS_LIST_MUTATIONS], 
				function(rows){
					if (rows.length !== 1)
						throw Error("zero or more than one best parent unit?");
					my_best_parent_unit = rows[0].unit;
					if (my_best_parent_unit !== objValidationState.best_parent_unit)
						throwError("different best parents, validation: "+objValidationState.best_parent_unit+", writer: "+my_best_parent_unit);
					conn.query("UPDATE units SET best_parent_unit=? WHERE unit=?", [my_best_parent_unit, objUnit.unit], function(){ cb(); });
				}
			);
		}
		
		function determineMaxLevel(handleMaxLevel){
			var max_level = 0;
			async.each(
				objUnit.parent_units, 
				function(parent_unit, cb){
					storage.readStaticUnitProps(conn, parent_unit, function(props){
						if (props.level > max_level)
							max_level = props.level;
						cb();
					});
				},
				function(){
					handleMaxLevel(max_level);
				}
			);
		}
		
		function updateLevel(cb){
			conn.cquery("SELECT MAX(level) AS max_level FROM units WHERE unit IN(?)", [objUnit.parent_units], function(rows){
				if (!conf.bFaster && rows.length !== 1)
					throw Error("not a single max level?");
				determineMaxLevel(function(max_level){
					if (conf.bFaster)
						rows = [{max_level: max_level}]
					if (max_level !== rows[0].max_level)
						throwError("different max level, sql: "+rows[0].max_level+", props: "+max_level);
					objNewUnitProps.level = max_level + 1;
					conn.query("UPDATE units SET level=? WHERE unit=?", [rows[0].max_level + 1, objUnit.unit], function(){
						cb();
					});
				});
			});
		}
		
		
		function updateWitnessedLevel(cb){
			profiler.start();
			if (objUnit.witnesses)
				updateWitnessedLevelByWitnesslist(objUnit.witnesses, cb);
			else
				storage.readWitnessList(conn, objUnit.witness_list_unit, function(arrWitnesses){
					updateWitnessedLevelByWitnesslist(arrWitnesses, cb);
				});
		}
		
		// The level at which we collect at least 7 distinct witnesses while walking up the main chain from our unit.
		// The unit itself is not counted even if it is authored by a witness
		function updateWitnessedLevelByWitnesslist(arrWitnesses, cb){
			var arrCollectedWitnesses = [];
			
			function setWitnessedLevel(witnessed_level){
				profiler.start();
				if (witnessed_level !== objValidationState.witnessed_level)
					throwError("different witnessed levels, validation: "+objValidationState.witnessed_level+", writer: "+witnessed_level);
				objNewUnitProps.witnessed_level = witnessed_level;
				conn.query("UPDATE units SET witnessed_level=? WHERE unit=?", [witnessed_level, objUnit.unit], function(){
					profiler.stop('write-wl-update');
					cb();
				});
			}
			
			function addWitnessesAndGoUp(start_unit){
				profiler.start();
				storage.readStaticUnitProps(conn, start_unit, function(props){
					profiler.stop('write-wl-select-bp');
					var best_parent_unit = props.best_parent_unit;
					var level = props.level;
					if (level === null)
						throw Error("null level in updateWitnessedLevel");
					if (level === 0) // genesis
						return setWitnessedLevel(0);
					profiler.start();
					storage.readUnitAuthors(conn, start_unit, function(arrAuthors){
						profiler.stop('write-wl-select-authors');
						profiler.start();
						for (var i=0; i<arrAuthors.length; i++){
							var address = arrAuthors[i];
							if (arrWitnesses.indexOf(address) !== -1 && arrCollectedWitnesses.indexOf(address) === -1)
								arrCollectedWitnesses.push(address);
						}
						profiler.stop('write-wl-search');
						(arrCollectedWitnesses.length < constants.MAJORITY_OF_WITNESSES) 
							? addWitnessesAndGoUp(best_parent_unit) : setWitnessedLevel(level);
					});
				});
			}
			
			profiler.stop('write-update');
			addWitnessesAndGoUp(my_best_parent_unit);
		}
		
		
		var objNewUnitProps = {
			bAA: objValidationState.bAA,
			unit: objUnit.unit,
			timestamp: timestamp,
			level: bGenesis ? 0 : null,
			latest_included_mc_index: null,
			main_chain_index: bGenesis ? 0 : null,
			is_on_main_chain: bGenesis ? 1 : 0,
			is_free: 1,
			is_stable: bGenesis ? 1 : 0,
			witnessed_level: bGenesis ? 0 : (conf.bFaster ? objValidationState.witnessed_level : null),
			headers_commission: objUnit.headers_commission || 0,
			payload_commission: objUnit.payload_commission || 0,
			sequence: objValidationState.sequence,
			author_addresses: arrAuthorAddresses,
			witness_list_unit: (objUnit.witness_list_unit || objUnit.unit)
		};
		if (!bGenesis)
			objNewUnitProps.parent_units = objUnit.parent_units;
		if ("earned_headers_commission_recipients" in objUnit) {
			objNewUnitProps.earned_headers_commission_recipients = {};
			objUnit.earned_headers_commission_recipients.forEach(function(row){
				objNewUnitProps.earned_headers_commission_recipients[row.address] = row.earned_headers_commission_share;
			});
		}
		
		// without this locking, we get frequent deadlocks from mysql
		mutex.lock(["write"], function(unlock){
			console.log("got lock to write "+objUnit.unit);
			var batch = bCordova ? null : (bInLargerTx ? objValidationState.batch : kvstore.batch());
			if (bGenesis){
				storage.assocStableUnits[objUnit.unit] = objNewUnitProps;
				storage.assocStableUnitsByMci[0] = [objNewUnitProps];
			}
			else
				storage.assocUnstableUnits[objUnit.unit] = objNewUnitProps;
			if (!bGenesis && storage.assocUnstableUnits[my_best_parent_unit]) {
				if (!storage.assocBestChildren[my_best_parent_unit])
					storage.assocBestChildren[my_best_parent_unit] = [];
				storage.assocBestChildren[my_best_parent_unit].push(objNewUnitProps);
			}
			addInlinePaymentQueries(function(){
				async.series(arrQueries, function(){
					profiler.stop('write-raw');
					var arrOps = [];
					if (objUnit.parent_units){
						if (!conf.bLight){
							if (objValidationState.bAA /*&& (!constants.bTestnet || objValidationState.initial_trigger_mci > testnetAAsDefinedByAAsAreActiveImmediatelyUpgradeMci)*/) {
								if (!objValidationState.initial_trigger_mci)
									throw Error("no initial_trigger_mci");
								var arrAADefinitionPayloads = objUnit.messages.filter(function (message) { return (message.app === 'definition'); }).map(function (message) { return message.payload; });
								if (arrAADefinitionPayloads.length > 0) {
									arrOps.push(function (cb) {
										console.log("inserting new AAs defined by an AA after adding " + objUnit.unit);
										storage.insertAADefinitions(conn, arrAADefinitionPayloads, objUnit.unit, objValidationState.initial_trigger_mci, true, cb);
									});
								}
							}
							if (!conf.bFaster)
								arrOps.push(updateBestParent);
							arrOps.push(updateLevel);
							if (!conf.bFaster)
								arrOps.push(updateWitnessedLevel);
							arrOps.push(function(cb){
								console.log("updating MC after adding "+objUnit.unit);
								main_chain.updateMainChain(conn, batch, null, objUnit.unit, objValidationState.bAA, cb);
							});
						}
						if (preCommitCallback)
							arrOps.push(function(cb){
								console.log("executing pre-commit callback");
								preCommitCallback(conn, cb);
							});
					}
					async.series(arrOps, function(err){
						profiler.start();
						
						function saveToKvStore(cb){
							if (err && bInLargerTx)
								throw Error("error on externally supplied db connection: "+err);
							if (err)
								return cb();
							if (objUnit.messages){
								objUnit.messages.forEach(function(message){
									if (message.app === 'data_feed' || message.app === 'definition') {
										if (!storage.assocUnstableMessages[objUnit.unit])
											storage.assocUnstableMessages[objUnit.unit] = [];
										storage.assocUnstableMessages[objUnit.unit].push(message);
									}
								});
							}
							if (!conf.bLight){
							//	delete objUnit.timestamp;
								delete objUnit.main_chain_index;
							}
							if (bCordova) // already written to joints table
								return cb();
							var batch_start_time = Date.now();
							batch.put('j\n'+objUnit.unit, JSON.stringify(objJoint));
							if (bInLargerTx)
								return cb();
							batch.write(function(err){
								console.log("batch write took "+(Date.now()-batch_start_time)+'ms');
								if (err)
									throw Error("writer: batch write failed: "+err);
								cb();
							});
						}
						
						saveToKvStore(function(){
							commit_fn(err ? "ROLLBACK" : "COMMIT", function(){
								var consumed_time = Date.now()-start_time;
								profiler.add_result('write', consumed_time);
								console.log((err ? (err+", therefore rolled back unit ") : "committed unit ")+objUnit.unit+", write took "+consumed_time+"ms");
								profiler.stop('write-commit');
								profiler.increment();
								if (err) {
									var headers_commission = require("./headers_commission.js");
									headers_commission.resetMaxSpendableMci();
									storage.resetMemory(conn, function(){
										unlock();
										if (!bInLargerTx)
											conn.release();
									});
								}
								else{
									unlock();
									if (!bInLargerTx)
										conn.release();
								}
								if (!err){
									eventBus.emit('saved_unit-'+objUnit.unit, objJoint);
									eventBus.emit('saved_unit', objJoint);
								}
								if (onDone)
									onDone(err);
								count_writes++;
								if (conf.storage === 'sqlite')
									updateSqliteStats(objUnit.unit);
							});
						});
					});
				});
			});
		});
		
	});
}

function readCountOfAnalyzedUnits(handleCount){
	if (count_units_in_prev_analyze)
		return handleCount(count_units_in_prev_analyze);
	db.query("SELECT * FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'", function(rows){
		if (rows.length === 0)
			return handleCount(0);
		db.query("SELECT stat FROM sqlite_stat1 WHERE tbl='units' AND idx='sqlite_autoindex_units_1'", function(rows){
			if (rows.length !== 1){
				console.log('no stat for sqlite_autoindex_units_1');
				return handleCount(0);
			}
			handleCount(parseInt(rows[0].stat.split(' ')[0]));
		});
	});
}

var start_time = 0;
var prev_time = 0;
var bDbTooBig = false;
// update stats for query planner
function updateSqliteStats(unit){
	if (count_writes === 1){
		start_time = Date.now();
		prev_time = Date.now();
	}
	if (count_writes % 100 !== 0)
		return;
	var STATS_CHUNK_SIZE = 1000;
	if (count_writes % STATS_CHUNK_SIZE === 0){
		var total_time = (Date.now() - start_time)/1000;
		var recent_time = (Date.now() - prev_time)/1000;
		var recent_tps = STATS_CHUNK_SIZE/recent_time;
		var avg_tps = count_writes/total_time;
		prev_time = Date.now();
	//	console.error(count_writes+" units done in "+total_time+" s, recent "+recent_tps+" tps, avg "+avg_tps+" tps, unit "+unit);
	}
	if (conf.storage !== 'sqlite' || bDbTooBig)
		return;
	db.query("SELECT MAX(rowid) AS count_units FROM units", function(rows){
		var count_units = rows[0].count_units;
		if (count_units > 500000){ // the db is too big
			bDbTooBig = true;
			return;
		}
		readCountOfAnalyzedUnits(function(count_analyzed_units){
			console.log('count analyzed units: '+count_analyzed_units);
			if (count_units < 2*count_analyzed_units)
				return;
			count_units_in_prev_analyze = count_units;
			console.log("will update sqlite stats");
			db.query("ANALYZE", function(){
				db.query("ANALYZE sqlite_master", function(){
					console.log("sqlite stats updated");
				});
			});
		});
	});
}

function throwError(msg){
	if (typeof window === 'undefined')
		throw Error(msg);
	else
		eventBus.emit('nonfatal_error', msg, new Error());
}

exports.saveJoint = saveJoint;

