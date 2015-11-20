
var AWS = require('aws-sdk');
var CfnLambda = require('cfn-lambda');

var DynamoDB = new AWS.DynamoDB({version: '2012-08-10'});

exports.handler = CfnLambda({
  Create: Create,
  Update: Update,
  Delete: Delete,
  SchemaPath: [__dirname, 'schema.json']
});

function Create(params, reply) {
  DynamoDB.describeTable({
    TableName: params.TableName
  }, function(findTableError, foundTable) {
    if (findTableError) {
      console.error('Error finding table on which to ' +
        'enable StreamSpecification: %j', findTableError);
      return reply(findTableError.message);
    }
    if (foundTable.Table.StreamSpecification &&
      foundTable.Table.StreamSpecification.StreamEnabled) {
      return reply('Table already has an enabled StreamSpecification!');
    }
    console.log('Found the table, adding StreamSpecification: %j', foundTable);
    makeStreamSpec(params, function(creationErr, stabilizedTableData) {
      if (creationErr) {
        console.error('Table StreamSpecification failed to Create: %j', creationErr);
        return reply(creationErr.message);
      }
      console.log('SUCCESS: Created Stream ' +'Specification: %j', stabilizedTableData);
      reply(null, toPhysicalId(params), {
        Arn: stabilizedTableData.Table.LatestStreamArn
      });
    });
  });
}

function makeStreamSpec(params, callback) {
  console.log('Attempting to add a StreamSpecification ' +
    'to table: %j', params);
  DynamoDB.updateTable({
    TableName: params.TableName,
    StreamSpecification: {
      StreamEnabled: true,
      StreamViewType: params.StreamViewType
    }
  }, function(streamSpecAddError, streamSpecAddResult) {
    if (streamSpecAddError) {
      console.log('Error when attempting StreamSpecification ' +
        'addition activation: %j', streamSpecAddError);
      return callback(streamSpecAddError);
    }
    console.log('Successfully triggered StreamSpecification ' +
      'addition (but not complete yet): %j', streamSpecAddResult);
    stabilizeTable(params.TableName, callback);
  });
}

function stabilizeTable(table, callback) {
  // Count number of times we check if Table is ACTIVE
  var waitIncementsPassedBy = 0;
  // Wait 1 second before recursive calls to check state
  var waitIncementsInterval = 1000;
  // Try appx. 3 minutes
  var waitIncrementsToAllow = 2 * 60;
  // Begin recursively checking.
  console.log('Beginning wait sequence to allow Table to stabilize to ACTIVE...');
  wait();

  function wait() {
    DynamoDB.describeTable({
      TableName: table
    }, function(checkTableErr, checkTableState) {
      if (checkTableErr) {
        console.log('Encountered error during table StreamSpecification' +
          'stabilization wait cycle: %j', checkTableErr);
        return callback(checkTableErr);
      }
      // No errors, check state (maybe recurse)
      if (checkTableState.Table.TableStatus !== 'ACTIVE') {
        // Recurse if below count...
        if (waitIncementsPassedBy < waitIncrementsToAllow) {
          // This is fine then.
          waitIncementsPassedBy++;
          console.log('Table not ACTIVE yet, waiting longer ' +
            ' (checked %s times).', waitIncementsPassedBy);
          // Ensure no flooding by waiting for the interval to go by.
          return setTimeout(wait, waitIncementsInterval);
        }
        // Else get really mad!
        console.error('TIMEOUT with %s increments of %s ms each ' +
          'passed by and table is not ACTIVE, ' +
          'sending FAILURE.', waitIncementsPassedBy, waitIncementsInterval);
        console.error('Stuck Table: %j', checkTableState)
        return callback({
          message: 'Table took too long to stabilize after StreamSpecification change.'
        });
      }
      // Status was ACTIVE so be happy and callback
      console.log('Table stabilized after %s wait increments of %s ms: %j',
        waitIncementsPassedBy + 1, waitIncementsInterval, checkTableState);
      callback(null, checkTableState);
    });
  }
}

function Update(physicalId, params, oldParams, reply) {
  if (params.TableName !== oldParams.TableName) {
    console.log('Tables have changed, delegating to Create ' +
      'on new table and allowing UPDATE_CLEANUP to sanitize old table.');
    return Create(params, reply);
  }
  DynamoDB.describeTable({
    TableName: params.TableName
  }, function(findTableError, foundTable) {
    if (findTableError) {
      console.error('Error finding table on which to ' +
        'Update StreamSpecification: %j', findTableError);
      return reply(findTableError.message);
    }
    destroyStreamSpec(params.TableName, function(destroyOldSpecError, 
                                                 stabilizedTableData) {
      if (destroyOldSpecError) {
        console.error('Failed to destroy old StreamSpecification ' +
          'to UPDATE: %j', destroyOldSpecError);
        return reply(destroyOldSpecError.message);
      }
      console.log('Destoyed old StreamSpecification, ' +
        'now creating new one: %j', stabilizedTableData);
      makeStreamSpec(params, function(creationErr, restabilizedTableData) {
        if (creationErr) {
          console.error('Updated table StreamSpecification ' +
            'failed to create: %j', creationErr);
          return reply(creationErr.message);
        }
        console.log('SUCCESS: Created StreamSpecification ' +
          'to finish UPDATE: %j', restabilizedTableData);
        reply(null, toPhysicalId(params), {
          Arn: restabilizedTableData.Table.LatestStreamArn
        });
      });
    });
  });
}

function destroyStreamSpec(table, callback) {
  DynamoDB.updateTable({
    TableName: table,
    StreamSpecification: {
      StreamEnabled: false,
      StreamViewType: null
    }
  }, function(streamSpecRemoveErr, streamSpecRemoveResult) {
    if (streamSpecRemoveErr) {
      console.log('Error when attempting StreamSpecification ' +
        'dectivation sequence start: %j', streamSpecRemoveErr);
      return callback(streamSpecRemoveErr);
    }
    console.log('Successfully triggered StreamSpecification ' +
      'deletion (but not complete yet): %j', streamSpecRemoveResult);
    stabilizeTable(table, callback);
  });
}

function Delete(physicalId, params, reply) {
  DynamoDB.describeTable({
    TableName: params.TableName
  }, function(findTableError, foundTable) {
    if (findTableError && findTableError.statusCode === 404) {
      console.log('During Delete, the table was not found. ' +
        'Implicit SUCCESS: %j', findTableError);
      return reply();
    }
    if (findTableError) {
      console.error('Error finding table to Delete ' +
        'StreamSpecification from: %j', findTableError);
      return reply(findTableError.message);
    }
    if (physicalId !== toPhysicalId({
      StreamViewType: foundTable.Table.StreamSpecification.StreamViewType,
      TableName: params.TableName
    })) {
      console.log('Appears this is an UPDATE_CLEANUP, mismatched deletion signature.');
      console.log('Non-deleted stream table: %j', foundTable);
      return reply();
    }
    destroyStreamSpec(params.TableName, function(destroyTableErr, stabilizedTableData) {
      if (destroyTableErr) {
        console.error('Table StreamSpecification failed to Delete: %j', destroyTableErr);
        return reply(destroyTableErr.message);
      }
      console.log('SUCCESS: Created StreamSpecification: %j', stabilizedTableData);
      reply();
    });
  });
}

function toPhysicalId(signature) {
  return [
    signature.TableName,
    signature.StreamViewType
  ].join('::');
}
