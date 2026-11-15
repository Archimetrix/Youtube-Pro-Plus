(function() {
    'use strict';
    history.pushState=(function(f){
        return function pushState(){
            var ret = f.apply(this, arguments); // was (that, thatArguments): the OUTER call's this/arguments, i.e. nothing -> 'Illegal invocation' on every pushState
            window.dispatchEvent(new Event('pushstate'));
            window.dispatchEvent(new Event('locationchange'));
            return ret;
        }
    })(history.pushState);

    history.replaceState = (function (f){
        return function replaceState(){
            var ret = f.apply(this, arguments); // was (that, thatArguments): the OUTER call's this/arguments, i.e. nothing -> 'Illegal invocation' on every pushState
            window.dispatchEvent(new Event('replacestate'));
            window.dispatchEvent(new Event('locationchange'));
            return ret;
        }
    })(history.replaceState);

    window.addEventListener('popstate',function(){
        window.dispatchEvent(new Event('locationchange'))
    });

    window.addEventListener("yt-navigate-finish", function(event) {
        window.dispatchEvent(new Event('locationchange'))
    });

    window.addEventListener("spfdone", function(e) {
        window.dispatchEvent(new Event('locationchange'))
    });

    function updateAvailablePlaybackRates() {
        var path = '';
        if(typeof _yt_player === "undefined"){ return; }
        
        function findAvailablePlaybackRates(objectToSave,prep) {
            var count=0;
            for(var i in objectToSave){
                if(Object.keys(objectToSave)[count] && objectToSave[Object.keys(objectToSave)[count]]){
                    if(Object.keys(objectToSave)[count] == "getAvailablePlaybackRates"){
                        path = (prep===""?"":prep+".")+Object.keys(objectToSave)[count];
                    } else if(objectToSave[Object.keys(objectToSave)[count]]?.prototype?.getAvailablePlaybackRates !== undefined){
                        path = (prep===""?"":prep+".")+Object.keys(objectToSave)[count]+".prototype.getAvailablePlaybackRates";
                    }
                    if(path !== '') return;
                    var objOfObj = objectToSave[Object.keys(objectToSave)[count]];
                    if( typeof objOfObj !== "undefined" && objectToSave[i].constructor.name == "Function" && Object.keys(objOfObj).length !== 0 ){
                        var incount = 0;
                        for(var j in objOfObj){
                            if(typeof objOfObj !== "undefined"){
                                findAvailablePlaybackRates(objOfObj[j],(prep===""?"":prep+".")+Object.keys(objectToSave)[count]+"."+Object.keys(objOfObj)[incount]);
                            }
                            if(path !== '') return;
                            incount++;
                        }
                    }
                }
                count++;
            }
        }

        findAvailablePlaybackRates(_yt_player,"");

        function setAvailablePlaybackRates(path,index,splitted) {
            if(splitted.length - 1 == index){
                path[splitted[index]] = function(){return [0.25,0.5,.75,1,1.25,1.5,1.75,2,2.25,2.5,2.75,3,3.25,3.5,3.75,4,5,6,7,8,9,10]};
            }else setAvailablePlaybackRates(path[splitted[index]],index+1,splitted);
        }

        if(path !== "") setAvailablePlaybackRates(_yt_player,0,path.split('.'));
    }

    function runUpdateAvailablePlaybackRates() {
        if(typeof _yt_player === "undefined"){
            // One poller only (this used to start a new 5ms timer on every
            // navigation, and they piled up if _yt_player never appeared),
            // polled gently, and given up on after ~30s.
            if (window.__ytppRateWait) return;
            var tries = 0;
            window.__ytppRateWait = setInterval(function(){
                if(typeof _yt_player !== "undefined"){
                    clearInterval(window.__ytppRateWait); window.__ytppRateWait = null;
                    updateAvailablePlaybackRates();
                } else if (++tries > 600) {
                    clearInterval(window.__ytppRateWait); window.__ytppRateWait = null;
                }
            },50);
        }else{
            updateAvailablePlaybackRates();
        }
    }

    function run(){ runUpdateAvailablePlaybackRates(); }
    window.addEventListener('locationchange', run);
    run();
})();