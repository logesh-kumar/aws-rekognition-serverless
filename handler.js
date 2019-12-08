"use strict";

const config = require("./config"),
  axios = require("axios"),
  request = require("request"),
  AWS = require("aws-sdk"),
  fs = require("fs"),
  s3 = new AWS.S3(),
  utils = require("./utils"),
  rekognition = new AWS.Rekognition({ region: config.aws.region });

function downloadImages(url, bucket, key, imageuid) {
  return axios
    .get(url, {
      responseType: "arraybuffer"
    })
    .then(response => {
      let extn = "JPG";
      return {
        Bucket: bucket,
        Key: `${key}.${extn}`,
        Body: new Buffer(response.data, "base64"),
        imageuid: imageuid
      };
    })
    .catch(e => {
      console.log(e);
      return Promise.reject(e);
    });
}

module.exports.createFaceCollection = (event, context, callback) => {
  return utils
    .createCollection()
    .then(response => {
      console.log(response);
      callback(null, {
        body: JSON.stringify(response),
        statusCode: 200
      });
    })
    .catch(e => {
      console.log(e);
      callback(e);
    });
};

function mapDownloadImages(assessmentDataArray) {
  console.log(assessmentDataArray);
  let promises = assessmentDataArray.map(d => {
    return downloadImages(
      d.url,
      config.aws.bucket,
      `${d.imageuid}-${d.name}`,
      d.imageuid
    );
  });
  return Promise.all(promises);
}

function processDownloadImages(assessmentDataArray, callback) {
  return mapDownloadImages(assessmentDataArray)
    .then(response => {
      const faceData = response;
      return utils.findMatchedFaceDetailFromDb(faceData);
    })
    .then(response => {
      console.log("Afeter db call to find matched image data");
      let promises = response.map(result => {
        let uid = result.imageuid
          ? result.imageuid
          : result["Item"].imageUid
          ? result["Item"].imageUid
          : "not found";
        return axios.post(
          "https://us-central1-lynkhacksmock.cloudfunctions.net/verifyface",
          {
            teamname: config.teamName,
            imageuid: uid,
            name: result && result.Item ? result.Item.name : "notfound"
          }
        );
      });
      return Promise.all(promises);
    })
    .then(res => {
      console.log("posted to assessment api");
      let totalCorrectResult =
        res &&
        res.reduce((accumulator, currentValue) => {
          const verifyResult = currentValue.data;
          if (verifyResult === "face score 1") {
            console.log(currentValue);
          } else {
            console.warn(currentValue);
          }
          return verifyResult === "face score 1"
            ? accumulator + 1
            : accumulator;
        }, 0);

      let imageResponse =
        res &&
        res.map(user => {
          let requestData = JSON.parse(user.config.data);
          console.log(requestData.imageuid);
          const { imageuid, name } = requestData;
          return { name, imageuid };
        });
      console.log(typeof callback);
      callback(null, {
        headers: {
          "Access-Control-Allow-Origin": "*" // Required for CORS support to work
        },
        body: JSON.stringify({
          totalCorrectResult: totalCorrectResult,
          responseTable: imageResponse
        }),
        statusCode: 200
      });
    })
    .catch(e => {
      console.log(e);
      callback({
        error: e.error ? e.error : "error"
      });
    });
}

module.exports.searchFaceInCollection = (event, context, callback) => {
  console.log("inside searchFaceInCollection");
  if (event.httpMethod === "GET") {
    const url =
      event.queryStringParameters && event.queryStringParameters.url
        ? event.queryStringParameters.url
        : "";
    const reqImageUrl =
      event.queryStringParameters && event.queryStringParameters.imageUrl
        ? event.queryStringParameters.imageUrl
        : "";
    const reqImageUid =
      event.queryStringParameters && event.queryStringParameters.imageUid
        ? event.queryStringParameters.imageUid
        : "";
    if (!url) {
      if (!reqImageUrl) {
        callback({ error: "Invalid url" });
      } else {
        let mockArray = [{ imageuid: reqImageUid, url: reqImageUrl }];
        processDownloadImages(mockArray, callback);
      }
    } else {
      axios.get(url).then(res => {
        processDownloadImages(res.data, callback);
      });
    }
  } else if (event.httpMethod === "POST") {
    callback(null, {
      headers: {
        "Access-Control-Allow-Origin": "*" // Required for CORS support to work
      },
      body: JSON.stringify(response),
      statusCode: 200
    });
  }
};

module.exports.addImagesToFacesCollection = (event, context, callback) => {
  //s3 objects response
  /*  {
     "Key": "22-suganya.jpeg",
     "LastModified": "2017-09-16T14:20:48.000Z",
     "ETag": "\"2c0eaad74b26d7337cc733410bdaadd8\"",
     "Size": 356963,
     "StorageClass": "STANDARD",
     "Owner": {
     "DisplayName": "logeshkumar.r",
     "ID": "dd487e7eb19fd19cc545f3b93c61b51246e6f35aeb1280a6415e10a8b034ce7e"
     }
     */
  s3.listObjects({
    Bucket: config.aws.bucket
  })
    .promise()
    .then(response => {
      //response = response.Contents.slice(0, 1);
      let promises = response.Contents.map(data => {
        return utils.indexFaces({
          userName: data.Key.split("-")[1].replace(".jpeg", ""),
          fileName: data.Key,
          imageUid: data.Key.split("-")[0]
        });
      });
      return Promise.all(promises);
    })
    .then(response => {
      console.log(response);
      callback(null, {
        body: JSON.stringify(response),
        statusCode: 200
      });
    })
    .catch(e => {
      console.log(e);
      callback(e);
    });
};

console.log(config.aws.bucket);
module.exports.handleTrainingData = (event, context, callback) => {
  if (event.httpMethod === "GET") {
    const queryParams = event.queryStringParameters;
    let trainingData = [];
    if (queryParams.url) {
      axios
        .get(queryParams.url)
        .then(res => {
          trainingData = res.data;
          let promises = trainingData.map(d => {
            return downloadImages(
              d.url,
              config.aws.bucket,
              `${d.imageuid}-${d.name}`
            );
          });
          return Promise.all(promises);
        })
        .then(s3Data => {
          let promises = s3Data.map(s => {
            console.log(s);
            return s3
              .putObject({
                Bucket: s.Bucket,
                Key: s.Key,
                ContentType: s.ContentType,
                ContentLength: s.ContentLength,
                ACL: "public-read",
                Body: s.Body // buffer
              })
              .promise();
          });

          return Promise.all(promises);
        })
        .then(images => {
          console.log(`Saved all images in s3`);
          const response = {
            body: "success",
            statusCode: 200
          };
          callback(null, response);
        })
        .catch(e => {
          console.log("error");
          callback(e);
        });
    } else {
      callback(null, { error: "Invalid query params" });
    }
  } else {
    callback({ error: "I don't care" });
  }
};
