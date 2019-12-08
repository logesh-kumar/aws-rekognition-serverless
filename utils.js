
const config = require('./config')
const AWS = require('aws-sdk');
const path = require('path');
AWS.config.region = config.aws.region;
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const rekognition = new AWS.Rekognition();
const collectionName = config.aws.collectionName;
const axios = require("axios")

// AWS allows you to create separate collections of faces to search in. 
// This creates the collection we'll use.
function createCollection() {
    // Index a dir of faces
    return rekognition.createCollection({ "CollectionId": collectionName }).promise()
}

function utilFunctionToSaveUser(user) {
    //actual dynamo db operation
    if (typeof user.id !== 'string') {
        console.error('Validation Failed');
        return Promise.reject({
            statusCode: 400,
            headers: { 'Content-Type': 'text/plain' },
            body: 'Couldn\'t create the todo item.',
        });
    }
    console.log(process.env.dynamodb_table);
    const params = {
        TableName: process.env.dynamodb_table,
        Item: user
    };
    return new Promise((resolve, reject) => {
        dynamoDb.put(params, (error) => {
            // handle potential errors
            if (error) {
                console.error(error);
                reject({
                    statusCode: error.statusCode || 501,
                    headers: { 'Content-Type': 'text/plain' },
                    body: 'Couldn\'t create the todo item.',
                });
            }
            resolve(params.Item)
        });
    });
}

// This loads a bunch of named faces into a db. It uses the name of the image as the 'externalId'
// Reads from a sub folder named 'faces'
function indexFaces(fileData) {
    const timestamp = new Date().getTime();
    return new Promise((resolve, reject) => {
        rekognition.indexFaces({
            "CollectionId": collectionName,
            "DetectionAttributes": ["ALL"],
            "ExternalImageId": fileData.userName,
            "Image": {
                // "Bytes": fileData.fileBuffer
                "S3Object": {
                    "Bucket": config.aws.bucket,
                    "Name": fileData.fileName
                }
            }
        }, function (err, data) {
            if (err) {
                console.log(err, err.stack); // an error occurred
                reject(err)
            } else {
                let user = {};
                if (data.FaceRecords && data.FaceRecords.length > 0) {
                    let firstUserFaceRecords = data.FaceRecords[0].Face;
                    let firstUserFaceDetail = data.FaceRecords[0].FaceDetail;
                    user.id = firstUserFaceRecords.FaceId;
                    user.imageId = firstUserFaceRecords.ImageId;
                    user.externalImageId = firstUserFaceRecords.ExternalImageId;
                    user.confidence = firstUserFaceRecords.Confidence;
                    user.gender = firstUserFaceDetail.Gender.Value;
                    user.name = fileData.userName;
                    user.imageUid = fileData.imageUid;
                    user.createdAt = timestamp;
                    user.updatedAt = timestamp;
                    resolve(user)
                }
            }
        });
    }).then(user => {
        console.log(JSON.stringify(user));
        return utilFunctionToSaveUser(user)
    })
}

function getObjectCollection() {

}

// Once you've created your collection you can run this to test it out.
function faceSearch(filename) {
    console.log("inside face search")
    return new Promise((resolve, reject) => {
        rekognition.searchFacesByImage({
            "CollectionId": collectionName,
            "FaceMatchThreshold": 80,
            "Image": {
                Bytes: filename.Body
                /* "S3Object": {
                    "Bucket": config.aws.bucket,
                    "Name": filename
                } */
            },
            "MaxFaces": 1
        }, function (err, data) {
            if (err) {
                console.log(err, err.stack); // an error occurred
                reject(err)
            } else {
                const tempObj = Object.assign({}, data, { imageuid: filename.imageuid });
                //console.log("tempData=======")
                console.log(tempObj);           // successful response
                //console.log("tempData=======End")
                resolve(tempObj)
            }
        })
    })
}

// This uses the detect labels API call on a local image.
function DetectLabelsTest(imagePath) {
    var bitmap = fs.readFileSync(imagePath);

    var params = {
        Image: {
            Bytes: bitmap
        },
        MaxLabels: 10,
        MinConfidence: 50.0
    };

    rekognition.detectLabels(params, function (err, data) {
        if (err) {
            console.log(err, err.stack); // an error occurred
        } else {
            console.log(data);           // successful response
        }
    });
}


function findMatchedFaceDetailFromDb(faceData) {
    console.log("faceDate=======")
    //console.log(faceData)
    console.log("faceDate=======end")
    let promises = faceData.map(img => {
        return faceSearch(img)
    });

    return Promise.all(promises)
        .then(response => {
            console.log("response=======")
            //console.log(response);
            console.log("response=======End")
            const matechedImageData = response;
            if (matechedImageData && matechedImageData.length < 1) {
                return Promise.reject({ error: "NO_MATCHED_IMAGES_IN_DB" })
            }
            let promises = matechedImageData.map(p => {
                //console.log(JSON.stringify(p))
                const matchedFaceId = p.FaceMatches[0] && p.FaceMatches[0]["Face"] ? p.FaceMatches[0]["Face"]["FaceId"] : null
                if (matchedFaceId) {
                    console.log(`Matched faceID is ${matchedFaceId}`)
                    const params = {
                        TableName: process.env.dynamodb_table,
                        Key: {
                            id: matchedFaceId,
                        },
                    };
                    return new Promise((resolve, reject) => {
                        return dynamoDb.get(params).promise()
                            .then(data => {
                                console.log("matechedImageData=======")
                                //console.log(matechedImageData);
                                //console.log("matechedImageData=======End")   
                                let objData = Object.assign({}, data, { imageuid: p.imageuid });
                                console.log("DB data=======")
                                //console.log(objData);
                                //console.log("db Data=======End")     
                                return resolve(objData)
                            })
                    })
                } else {
                    console.log(`No face adata for ${JSON.stringify(p)} `)
                    let objData = Object.assign({}, { imageuid: p.imageuid });
                    return Promise.resolve(objData);
                }
            })
            return Promise.all(promises);
        }).then(response => {
            console.log("Fetched matching face data from db")
            console.log(response)
            return Promise.resolve(response)
        })

}


module.exports = {
    indexFaces: indexFaces,
    faceSearch: faceSearch,
    createCollection: createCollection,
    findMatchedFaceDetailFromDb: findMatchedFaceDetailFromDb
}

